"""Decode the documented model-facing SpaceMolt evidence representation."""

def expand_evidence(packet):
    """Check the documented inline representation without losing any table cells."""
    def expand(value):
        if isinstance(value, list):
            return [expand(item) for item in value]
        if not isinstance(value, dict):
            return value
        if set(value) == {"ref"}:
            return expand(packet["shared_evidence"][str(value["ref"])])
        if set(value) == {"mission_ref", "overrides"}:
            return {**expand(packet["mission_evidence"][value["mission_ref"]]), **expand(value["overrides"])}
        expanded = {key: expand(item) for key, item in value.items()}
        if set(expanded) == {"columns", "rows"}:
            return [expand(dict(zip(expanded["columns"], row, strict=True))) for row in expanded["rows"]]
        return expanded
    return {key: expand(value) for key, value in packet.items()
            if key not in {"shared_evidence", "mission_evidence", "reading_note"}}

