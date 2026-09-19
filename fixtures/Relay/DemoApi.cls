Class Relay.DemoApi Extends %CSP.REST
{
XData UrlMap
{
<Routes><Route Url="/ping" Method="GET" Call="Ping" /></Routes>
}
ClassMethod Ping() As %Status
{
    Set %response.ContentType="application/json"
    Write "{""application"":""IRIS Relay lab fixture"",""ok"":true}"
    Quit $$$OK
}
}
