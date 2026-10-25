package api

import (
	"crypto/sha256"
	"encoding/base64"
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

// The presenting page carries its view and syncs through the parent window: the
// three views of the viewer, as a frame without storage needs them.
func TestPresent(t *testing.T) {
	src := deckSrc + "\n<!-- a note for the speaker -->\n"
	for view, want := range map[string]string{"": `"view"`, "overview": `"view":"overview"`, "presenter": `"view":"presenter"`} {
		r := call(t, "present", PresentRequest{Request: editor.Request{Path: "/w/deck.md", Source: src}, View: view})
		if r.Error != "" {
			t.Fatal(r.Error)
		}
		m := r.Result.(map[string]any)
		page := m["page"].(string)
		if !strings.HasPrefix(page, "<!DOCTYPE html>") || !strings.Contains(page, "Hello X") || !strings.Contains(page, `"sync":"parent"`) {
			t.Fatalf("%q: no presenting page: %.200s", view, page)
		}
		if view != "" && !strings.Contains(page, want) {
			t.Errorf("%q: the page does not name its view (%s)", view, want)
		}
		if view == "" && strings.Contains(page, `"view":"`) {
			t.Errorf("the slides page names a view")
		}
		lines := m["lines"].([]any)
		if len(lines) != 2 || lines[0].(float64) != 5 || lines[1].(float64) != 9 {
			// each slide begins on the line after the one that ends the one before
			t.Errorf("%q: slide lines %v, want [5 9]", view, lines)
		}
		if !strings.Contains(page, "a note for the speaker") {
			t.Errorf("%q: the speaker's note is not in the page", view)
		}
	}
	// a deck that does not build comes back as problems, with no page
	r := call(t, "present", PresentRequest{Request: editor.Request{Path: "/w/deck.md", Source: "---\nslides: true\n---\n\n{{ nope }}\n"}})
	m := r.Result.(map[string]any)
	if m["page"].(string) != "" || len(m["diagnostics"].([]any)) == 0 {
		t.Fatalf("a broken deck: %+v", m)
	}
	// a view that does not exist is refused
	r = call(t, "present", PresentRequest{Request: editor.Request{Path: "/w/deck.md", Source: deckSrc}, View: "next"})
	m = r.Result.(map[string]any)
	if m["page"].(string) != "" || len(m["diagnostics"].([]any)) != 1 {
		t.Fatalf("view next: %+v", m)
	}
	// files the project names are used, as the render does
	files := call(t, "present", PresentRequest{Request: editor.Request{Path: "/w/deck.md", Source: deckSrc,
		Files: map[string]string{"/w/slides.yaml": "kinds:\n  extra: {class: lead}\n"}, Dirs: map[string][]string{"/w": {"slides.yaml", "media/", "notes.md"}}}})
	if files.Error != "" || files.Result.(map[string]any)["page"].(string) == "" {
		t.Fatalf("with project files: %+v", files)
	}
	// the page's scripts are named by hash for the Content Security Policy
	plain := Present(PresentRequest{Request: editor.Request{Path: "/w/deck.md", Source: deckSrc}})
	if len(plain.Scripts) == 0 || strings.Count(plain.Page, "<script") != len(plain.Scripts) {
		t.Fatalf("%d hashes for %d scripts", len(plain.Scripts), strings.Count(plain.Page, "<script"))
	}
	for _, s := range plain.Scripts {
		if !strings.HasPrefix(s, "'sha256-") || !strings.HasSuffix(s, "='") {
			t.Fatalf("a hash source looks like 'sha256-…=': %s", s)
		}
	}
	// with raw HTML allowed a deck's own script is in the page, and not among the
	// scripts that may run: only the viewer's are named
	own := "<script>alert(1)</script>"
	loose := Present(PresentRequest{Request: editor.Request{Path: "/w/deck.md", Source: deckSrc + "\n" + own + "\n", HTML: true}, View: "presenter"})
	if !strings.Contains(loose.Page, own) {
		t.Fatal("html: true keeps the deck's script in the page")
	}
	strict := Present(PresentRequest{Request: editor.Request{Path: "/w/deck.md", Source: deckSrc + "\n" + own + "\n"}, View: "presenter"})
	if strings.Contains(strict.Page, own) {
		t.Fatal("the allow-list escapes it")
	}
	if len(loose.Scripts) == 0 || strings.Join(loose.Scripts, " ") != strings.Join(strict.Scripts, " ") {
		t.Fatalf("a deck's script is named by hash: %v vs %v", loose.Scripts, strict.Scripts)
	}
	sum := sha256.Sum256([]byte("alert(1)"))
	if strings.Contains(strings.Join(loose.Scripts, " "), base64.StdEncoding.EncodeToString(sum[:])) {
		t.Fatal("the deck's script hash is allowed")
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
	for _, m := range []string{"render", "present", "detect", "complete", "hover"} {
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
