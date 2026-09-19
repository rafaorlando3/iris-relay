Class Relay.LogReader Extends %RegisteredObject
{
/// Embedded Python reads fixed text sources, with bounded, rotation-aware paging.
ClassMethod Read(directory As %String, source As %String = "runtime", cursor As %String = "", list As %Boolean = 0) As %String [ Language = python ]
{
    import importlib.util
    import os
    import json
    spec = importlib.util.spec_from_file_location("relay_log_reader", os.path.join(directory, "relay", "log_reader.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return json.dumps(module.catalog(directory) if list else module.page(directory, source, cursor))
}
ClassMethod Tail(directory As %String) As %String
{
 Quit ..Read(directory)
}
}
