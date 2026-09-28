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
/// Refresh the similarity index (Relay.LogLine) from every available text log. Unchanged files are skipped.
ClassMethod IndexLogs(directory As %String) As %String [ Language = python ]
{
    import importlib.util
    import os
    import json
    import iris
    def load(name):
        spec = importlib.util.spec_from_file_location("relay_" + name, os.path.join(directory, "relay", name + ".py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    reader = load("log_reader")
    vectors = load("log_vectors")
    try:
        return json.dumps(vectors.refresh_iris(directory, reader, iris))
    except Exception as error:
        return json.dumps({"error": "Log index update failed: " + (str(error) or type(error).__name__)[:300]})
}

/// Rank indexed log lines by VECTOR_COSINE similarity to the query text.
ClassMethod SearchLogs(directory As %String, query As %String, limit As %Integer = 20) As %String [ Language = python ]
{
    import importlib.util
    import os
    import json
    import iris
    spec = importlib.util.spec_from_file_location("relay_log_vectors", os.path.join(directory, "relay", "log_vectors.py"))
    vectors = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(vectors)
    try:
        return json.dumps(vectors.search_iris(query, limit, iris))
    except Exception as error:
        return json.dumps({"error": "Log search failed: " + (str(error) or type(error).__name__)[:300]})
}

ClassMethod Tail(directory As %String) As %String
{
 Quit ..Read(directory)
}
}
