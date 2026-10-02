Class Relay.Api Extends %CSP.REST
{
Parameter CHARSET = "utf-8";
Parameter UseSession As INTEGER = 0;
XData UrlMap [ XMLNamespace = "http://www.intersystems.com/urlmap" ]
{
<Routes>
  <Route Url="/logs" Method="GET" Call="Logs"/>
  <Route Url="/log-sources" Method="GET" Call="Sources"/>
  <Route Url="/log-search" Method="GET" Call="Search"/>
  <Route Url="/log-index" Method="POST" Call="Index"/>
  <Route Url="/account" Method="GET" Call="Account"/>
  <Route Url="/account" Method="POST" Call="Account"/>
</Routes>
}
/// The signed-in IRIS account, and nothing else: no permission check, because it only
/// tells the caller its own username. IRIS Relay calls it to check a sign-in. On the
/// POST, the IRIS web login has already handled the standard IRISUsername,
/// IRISOldPassword and IRISPassword form fields before this method runs: IRIS itself
/// checked the old password, applied its password rules and changed the password.
ClassMethod Account() As %Status
{
 Set %response.ContentType="application/json"
 Write {"username":($USERNAME)}.%ToJSON()
 Quit 1
}
/// A refused sign-in to /account answers why, in JSON, so IRIS Relay can offer a
/// password change when IRIS requires one. Every other route keeps the standard
/// %CSP.REST answer. Only reasons that need the right password are told apart:
/// IRIS reports "password change required" (#935) only for a correct password, and
/// checks the old password of a change before its password rules. A wrong password,
/// an unknown or disabled account and anything else are all "denied".
/// No WWW-Authenticate header: a browser would open its own sign-in dialog.
ClassMethod Login(skipheader As %Boolean = 1) As %Status [ ProcedureBlock = 1 ]
{
 If (%request.Method="OPTIONS")||($Extract(%request.URL,$Length(%request.Application),*)'="/account") {
  Quit ##super(skipheader)
 }
 Set answer={"reason":"denied","error":"Access denied."}
 Try {
  Set answer=..LoginAnswer($Get(%request.Data("Error:ErrorCode",1)))
 } Catch {
 }
 Set %response.OutputSessionToken=0
 Set %response.Status="401 Unauthorized"
 Set %response.ContentType="application/json"
 If %response.Language="" Set %response.Language="en"
 Do %response.WriteHTTPHeader()
 Write answer.%ToJSON()
 Quit 1
}
/// The reason for a refused sign-in, from the IRIS status of the login attempt.
ClassMethod LoginAnswer(status As %String) As %DynamicObject
{
 Set codes="",texts=""
 Do ..StatusParts(status,.codes,.texts,1)
 If codes=$ListBuild(935) Quit {"reason":"password-change-required","error":"IRIS requires a password change for this account."}
 // #935 with #1446 (password change failed) and the reason. IRIS checks the old
 // password first, so #952 (invalid password) or #838 (no such user) stays "denied".
 Set denied=0
 For code=952,838,822 Set:$ListFind(codes,code) denied=1
 If ($ListGet(codes,1)=935)&&$ListFind(codes,1446)&&'denied&&(texts'="") {
  Quit {"reason":"password-rejected","error":"IRIS did not accept the new password.","detail":($Extract($ListToString(texts," "),1,500))}
 }
 Quit {"reason":"denied","error":"Access denied."}
}
/// Every error code in a status, embedded ones included, and the text of the errors
/// that carry the reason (all but #935 and #1446).
ClassMethod StatusParts(status As %String, ByRef codes As %List, ByRef texts As %List, depth As %Integer) [ Private ]
{
 Quit:(depth>8)||(status="")||$SYSTEM.Status.IsOK(status)
 Kill parts
 Do $SYSTEM.Status.DecomposeStatus(status,.parts)
 For i=1:1:+$Get(parts) {
  Set code=+$Get(parts(i,"code")),codes=codes_$ListBuild(code)
  Set embedded=$Get(parts(i,"embeddederror",1))
  If embedded'="" {
   Do ..StatusParts(embedded,.codes,.texts,depth+1)
  } ElseIf (code'=935)&&(code'=1446) {
   Set texts=texts_$ListBuild($Piece($Get(parts(i)),$Char(13),1))
  }
 }
}
ClassMethod Logs() As %Status
{
 Set %response.ContentType="application/json"
 If '$SYSTEM.Security.Check("%Admin_Operate","U") {
  Set %response.Status="403 Forbidden"
  Write "{",$Char(34),"error",$Char(34),":",$Char(34),"Permission denied",$Char(34),"}"
  Quit 1
 }
 Try {
  Write ##class(Relay.LogReader).Read($SYSTEM.Util.ManagerDirectory(),$Get(%request.Data("source",1),"runtime"),$Get(%request.Data("cursor",1),""),$Get(%request.Data("catalog",1),0))
 } Catch ex {
  Set %response.Status="503 Service Unavailable"
  Write "{",$Char(34),"error",$Char(34),":",$Char(34),"Runtime log unavailable",$Char(34),"}"
 }
 Quit 1
}
ClassMethod Sources() As %Status
{
 Set %request.Data("catalog",1)=1
 Quit ..Logs()
}
ClassMethod Search() As %Status
{
 Set %response.ContentType="application/json"
 If '$SYSTEM.Security.Check("%Admin_Operate","U") {
  Set %response.Status="403 Forbidden"
  Write "{",$Char(34),"error",$Char(34),":",$Char(34),"Permission denied",$Char(34),"}"
  Quit 1
 }
 Try {
  Write ##class(Relay.LogReader).SearchLogs($SYSTEM.Util.ManagerDirectory(),$Get(%request.Data("q",1)),+$Get(%request.Data("limit",1),20))
 } Catch ex {
  Set %response.Status="503 Service Unavailable"
  Write "{",$Char(34),"error",$Char(34),":",$Char(34),"Log search unavailable",$Char(34),"}"
 }
 Quit 1
}
ClassMethod Index() As %Status
{
 Set %response.ContentType="application/json"
 If '$SYSTEM.Security.Check("%Admin_Operate","U") {
  Set %response.Status="403 Forbidden"
  Write "{",$Char(34),"error",$Char(34),":",$Char(34),"Permission denied",$Char(34),"}"
  Quit 1
 }
 Try {
  Write ##class(Relay.LogReader).IndexLogs($SYSTEM.Util.ManagerDirectory())
 } Catch ex {
  Set %response.Status="503 Service Unavailable"
  Write "{",$Char(34),"error",$Char(34),":",$Char(34),"Log index unavailable",$Char(34),"}"
 }
 Quit 1
}
ClassMethod ReadLog() As %String
{
 Quit ##class(Relay.LogReader).Tail($SYSTEM.Util.ManagerDirectory())
}
}
