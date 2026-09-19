Class Relay.SmokeTask Extends %SYS.Task.Definition
{
Method OnTask() As %Status
{
 Set ^RelaySmoke($Increment(^RelaySmoke))=$Horolog
 Quit 1
}
}
