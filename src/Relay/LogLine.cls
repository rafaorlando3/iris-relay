/// One indexed text-log line for similarity search (IRIS Vector Search).
/// Rebuilt from the log files by Relay.LogReader.IndexLogs; it is a disposable cache, not an audit.
Class Relay.LogLine Extends %Persistent
{

Property Source As %String(COLLATION = "EXACT", MAXLEN = 128) [ Required ];

Property FileKey As %String(COLLATION = "EXACT", MAXLEN = 200);

Property LineNo As %Integer;

Property LineTime As %String(MAXLEN = 40);

Property LineLevel As %Integer;

Property Message As %String(MAXLEN = 2000);

Property Embedding As %Library.Vector(DATATYPE = "DOUBLE", LEN = 256);

Index SourceIdx On Source;

}
