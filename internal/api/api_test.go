package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/go-slides/slides/editor"
)

func call(t *testing.T, method string, req any) Response {
	t.Helper()
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var r Response
	if err := json.Unmarshal([]byte(Call(method, string(b))), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

const deckSrc = "---\nslides: true\nkinds:\n  intro: {class: lead}\n---\n\n# Hello {{ upper \"x\" }}\n\n---\n\n<!-- _kind: intro -->\n# Two\n"

func TestRender(t *testing.T) {
	r := call(t, "render", editor.Request{Path: "/w/deck.md", Source: deckSrc})
	if r.Error != "" {
		t.Fatal(r.Error)
	}
	m := r.Result.(map[string]any)
	if m["slides"].(float64) != 2 || !strings.Contains(m["html"].(string), "Hello X") {
		t.Fatalf("%v", m)
	}
}

func TestDetect(t *testing.T) {
	if r := call(t, "detect", DetectRequest{Source: deckSrc}); r.Result != true {
		t.Fatalf("%+v", r)
	}
	if r := call(t, "detect", DetectRequest{Source: "---\nmarp: true\n---\n"}); r.Result != false {
		t.Fatalf("marp: true without Marp accepted: %+v", r)
	}
}

func TestCompleteAndHover(t *testing.T) {
	src := strings.Replace(deckSrc, "_kind: intro", "_kind: ", 1)
	line := strings.Count(src[:strings.Index(src, "_kind: ")], "\n")
	col := len("<!-- _kind: ")
	r := call(t, "complete", Position{Request: editor.Request{Path: "/w/deck.md", Source: src}, Line: line, Character: col})
	b, _ := json.Marshal(r.Result)
	if !strings.Contains(string(b), `"label":"intro"`) {
		t.Fatalf("%s", b)
	}
	r = call(t, "complete", Position{Request: editor.Request{Path: "/w/deck.md", Source: "plain"}, Line: 0, Character: 2})
	if items, ok := r.Result.([]any); !ok || len(items) != 0 {
		t.Fatalf("plain text completions %+v", r)
	}
	r = call(t, "hover", Position{Request: editor.Request{Path: "/w/deck.md", Source: deckSrc}, Line: 1, Character: 2})
	if !strings.Contains(r.Result.(map[string]any)["doc"].(string), "go-slides") {
		t.Fatalf("%+v", r)
	}
}

func TestErrors(t *testing.T) {
	if r := call(t, "nope", nil); !strings.Contains(r.Error, "no method") {
		t.Fatalf("%+v", r)
	}
	for _, m := range []string{"render", "detect", "complete", "hover"} {
		var r Response
		if err := json.Unmarshal([]byte(Call(m, "{")), &r); err != nil || r.Error == "" {
			t.Errorf("%s accepted bad JSON: %+v %v", m, r, err)
		}
	}
	Methods["boom"] = func([]byte) (any, error) { panic("boom") }
	defer delete(Methods, "boom")
	if r := call(t, "boom", nil); !strings.Contains(r.Error, "panicked: boom") {
		t.Fatalf("a panic escaped: %+v", r)
	}
	if call(t, "version", nil).Result == "" {
		t.Fatal("no version")
	}
	if encode(Response{Result: func() {}}) == "" {
		t.Fatal("unencodable result")
	}
}
