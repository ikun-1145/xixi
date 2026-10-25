#!/usr/bin/env python3
"""Generate exact-count SQL only for critical tables present in an inventory."""
import json
import re
import sys

inventory = json.load(open(sys.argv[1]))
items = sorted({(item["schema"], item["name"]) for item in inventory["tables"]})
for schema, name in items:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", schema + name):
        raise RuntimeError("Unsafe identifier in inventory")
select = "SELECT json_build_object(\n" + ",\n".join(
    f"  '{schema}.{name}',(SELECT count(*) FROM \"{schema}\".\"{name}\")"
    for schema, name in items
) + "\n);\n" if items else "SELECT '{}'::json;\n"
with open(sys.argv[2], "w") as output:
    output.write("SET SESSION ROLE postgres;\nBEGIN TRANSACTION READ ONLY;\n" + select + "COMMIT;\n")
