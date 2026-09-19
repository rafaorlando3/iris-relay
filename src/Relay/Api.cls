Class Relay.Api Extends %CSP.REST
{
Parameter CHARSET = "utf-8";
Parameter UseSession As INTEGER = 0;
XData UrlMap [ XMLNamespace = "http://www.intersystems.com/urlmap" ]
{
<Routes>
  <Route Url="/logs" Method="GET" Call="Logs"/>
  <Route Url="/log-sources" Method="GET" Call="Sources"/>
</Routes>
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
ClassMethod ReadLog() As %String
{
 Quit ##class(Relay.LogReader).Tail($SYSTEM.Util.ManagerDirectory())
}
}
