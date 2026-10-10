import pytest

from mdium_worker import registry, stage


def setup_function() -> None:
    registry.clear()


def test_stage_registers_definition_and_function() -> None:
    @stage("x.y", inputs={"n": {"type": "number", "required": True}}, outputs={"o": {"type": "string"}})
    def fn(ctx, n):
        return None

    defs = registry.stages()
    assert [d.name for d in defs] == ["x.y"]
    assert defs[0].inputs["n"].type == "number" and defs[0].inputs["n"].required is True
    assert registry.get("x.y").fn is fn


def test_duplicate_names_are_rejected() -> None:
    @stage("dup")
    def one(ctx):
        return None

    with pytest.raises(ValueError):
        @stage("dup")
        def two(ctx):
            return None


def test_bad_input_type_in_definition_is_rejected() -> None:
    with pytest.raises(ValueError):
        @stage("bad", inputs={"n": {"type": "integer"}})
        def fn(ctx, n):
            return None


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"outputs": {"k": {"type": "file"}}}, "unknown type"),
        ({"outputs": {"k": "path"}}, "must be a dict"),
        ({"outputs": {"k": {"description": 3}}}, "description"),
        ({"artifacts": [{"mediaType": "video/mp4"}]}, "label"),
        ({"artifacts": [{"label": 1}]}, "label"),
        ({"artifacts": [{"label": "v", "mediaType": 4}]}, "mediaType"),
        ({"artifacts": {"label": "v"}}, "list"),
        ({"description": 5}, "description"),
        ({"inputs": {"n": {"type": "number", "default": "3"}}}, "default"),
        ({"inputs": {"b": {"type": "bool", "default": 1}}}, "default"),
        ({"inputs": {"s": {"type": "string", "description": ["x"]}}}, "description"),
    ],
)
def test_manifest_shapes_mdium_cannot_read_fail_at_import(kwargs, message) -> None:
    with pytest.raises(ValueError, match=message):
        @stage("bad", **kwargs)
        def fn(ctx, **_):
            return None


def test_valid_shapes_are_accepted() -> None:
    @stage("ok", description="d", inputs={"x": {"type": "string", "default": None}, "n": {"type": "number", "default": 2}},
           outputs={"o": {"type": "path", "description": "p"}, "any": {}},
           artifacts=[{"label": "video", "mediaType": "video/mp4"}, {"label": "log"}])
    def fn(ctx, x=None, n=2):
        return None

    assert registry.get("ok").to_json()["artifacts"][1] == {"label": "log"}
