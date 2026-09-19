"""Provision disposable local security examples, without contacting any OAuth provider."""
import base64
import json
import subprocess
import urllib.request
import urllib.error


def provision(name, url, credentials):
    headers = {
        'Authorization': 'Basic ' + base64.b64encode((credentials['username'] + ':' + credentials['password']).encode()).decode(),
        'Content-Type': 'application/json',
    }

    def request(path, method='GET', data=None):
        request = urllib.request.Request(url + '/api/admin' + path, method=method, headers=headers,
                                        data=json.dumps(data).encode() if data is not None else None)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                result = json.load(response)
                if result.get('status', {}).get('errors'):
                    raise RuntimeError('IRIS rejected security fixture setup.')
                return response.status, result.get('result')
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return 404, None
            raise RuntimeError('Security fixture request failed with HTTP ' + str(error.code)) from None

    if request('/v2/security/x509-credential?alias=RelayDemoCertificate')[0] == 404:
        subprocess.run(['docker', 'exec', name, 'openssl', 'req', '-x509', '-newkey', 'rsa:2048',
                        '-nodes', '-days', '30', '-subj', '/CN=relay-demo.invalid',
                        '-keyout', '/tmp/relay-demo-key.pem', '-out', '/tmp/relay-demo-cert.pem'],
                       check=True, capture_output=True, timeout=30)
        request('/v2/security/x509-credential?alias=RelayDemoCertificate', 'POST', {
            'Alias': 'RelayDemoCertificate', 'CertificateFile': '/tmp/relay-demo-cert.pem',
            'OwnerList': ['RelayLab'],
        })
        # Only the self-signed public certificate is imported; discard its unused lab key.
        subprocess.run(["docker", "exec", name, "rm", "-f", "/tmp/relay-demo-key.pem"], check=True, capture_output=True, timeout=10)

    if request('/v2/security/ssl-configuration?name=RelayDemoTLS')[0] == 404:
        request('/v2/security/ssl-configuration?name=RelayDemoTLS', 'PUT', {
            'Enabled': True, 'Type': 0, 'VerifyPeer': 1,
            'CAFile': '/etc/ssl/certs/ca-certificates.crt', 'Description': 'Local Relay demo; no provider discovery',
        })
    _, servers = request('/v2/security/oauth2/client/server-definitions')
    if not any(server.get('IssuerEndpoint') == 'https://relay-demo.invalid' for server in servers):
        request('/v2/security/oauth2/client/server-definition?discover=0', 'POST', {
            'IssuerEndpoint': 'https://relay-demo.invalid', 'SSLConfiguration': 'RelayDemoTLS',
            'Metadata': {'issuer': 'https://relay-demo.invalid',
                         'authorization_endpoint': 'https://relay-demo.invalid/authorize',
                         'token_endpoint': 'https://relay-demo.invalid/token'},
        })
    if request('/v2/security/oauth2/resource-server?name=RelayDemoOAuth')[0] == 404:
        request('/v2/security/oauth2/resource-server?name=RelayDemoOAuth', 'PUT', {
            'Enabled': False, 'Description': 'Isolated demo without attached application',
            'IssuerEndpoint': 'https://relay-demo.invalid', 'AccessTokenIsJWT': True,
            'Audiences': ['relay-demo'], 'ScopeRequiredToConnect': 'relay.demo',
            'Authenticator': {'Namespace': '%SYS', 'Implementation': '%OAuth2.ResourceServer.SimpleAuthenticator'},
        })

    if request('/v2/security/role?name=RelayDemoRole')[0] == 404:
        request('/v2/security/role?name=RelayDemoRole', 'PUT', {'Description':'Disposable unassigned Relay role', 'Resources':[], 'GrantedRoles':[], 'EscalationOnly':False})
