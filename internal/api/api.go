// Package api is the extension's one entry into Go: a method name and a
// JSON request in, a JSON response out. The WebAssembly module (package
// wasm) exposes Call to JavaScript; everything it does is go-slides'
// editor package, so the TypeScript side never parses, renders or decides.
package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"

	"github.com/go-slides/slides"
	"github.com/go-slides/slides/deck"
	"github.com/go-slides/slides/editor"
	"github.com/go-slides/slides/project"
	"github.com/go-slides/slides/vfs"
	"github.com/go-slides/slides/viewer"
)

// Position is a request at a place in the deck: 0-based line, UTF-16
// character.
type Position struct {
	editor.Request
	Line      int `json:"line"`
	Character int `json:"character"`
}

// DetectRequest asks whether a document is a deck to preview.
type DetectRequest struct {
	Source string `json:"source"`
	// Marp accepts marp: true (Marp for VS Code is not installed).
	Marp bool `json:"marp"`
}

// PresentRequest asks for the deck as a presenting page: the slides, the
// overview or the presenter view.
type PresentRequest struct {
	editor.Request
	// View is "" for the slides, "overview" or "presenter".
	View string `json:"view,omitempty"`
}

// PresentResult is a presenting page, or the problems that stopped it.
type PresentResult struct {
	// Page is the whole HTML document; empty when the deck did not build.
	Page string `json:"page"`
	// Lines is the 0-based source line of each slide, to reveal a slide chosen in
	// the overview.
	Lines []int `json:"lines"`
	// Scripts are the Content Security Policy hash sources ("'sha256-…'") of the
	// page's own inline scripts: the viewer's, and nothing a deck wrote. With raw
	// HTML allowed a deck can carry a script of its own; the page is then built a
	// second time with Marp's allow-list, and only the scripts of that build are
	// named, so the deck's never run.
	Scripts     []string            `json:"scripts"`
	Diagnostics []editor.Diagnostic `json:"diagnostics"`
	Missing     []string            `json:"missing"`
}

var scriptRE = regexp.MustCompile(`(?is)<script(?:\s[^>]*)?>(.*?)</script>`)

// scriptSources names a page's inline scripts for a script-src directive.
func scriptSources(page string) []string {
	var out []string
	for _, m := range scriptRE.FindAllStringSubmatch(page, -1) {
		sum := sha256.Sum256([]byte(m[1]))
		out = append(out, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
	}
	return out
}

// Present builds the presenting page of a deck as the viewer's three views have
// it when they sync through a parent window (viewer.SyncParent): the page posts
// {slidesSync: {index, fragmentIndex}} to its parent, takes the same from it, and
// asks it (slidesPresent) to open the presenter view. A page with no URL of its
// own, in a frame without storage, can only be told its view this way.
func Present(r PresentRequest) PresentResult {
	res := PresentResult{Diagnostics: []editor.Diagnostic{}, Lines: []int{}, Scripts: []string{}}
	switch r.View {
	case "", "overview", "presenter":
	default:
		res.Diagnostics = append(res.Diagnostics, editor.Diagnostic{File: r.Path, Severity: "error", Message: "go-slides: no view " + r.View})
		return res
	}
	files := make(map[string][]byte, len(r.Files)+1)
	for k, v := range r.Files {
		files[k] = []byte(v)
	}
	files[r.Path] = []byte(r.Source)
	m := vfs.NewMap(files)
	for d, names := range r.Dirs {
		m.Dir(d)
		for _, n := range names {
			if sub, ok := strings.CutSuffix(n, "/"); ok {
				m.Dir(filepath.Join(d, sub))
			} else if _, held := files[filepath.Join(d, n)]; !held {
				m.Listed(filepath.Join(d, n))
			}
		}
	}
	cfg, err := project.Load(r.Path, project.Options{FS: m, NoConfig: r.NoConfig})
	if err != nil {
		res.Diagnostics = editor.Diagnose(err, r.Path, r.Source)
		res.Missing = m.Missing()
		return res
	}
	if r.HTML {
		cfg.HTML = deck.HTMLAll
	} else {
		cfg.HTML = deck.HTMLAllowlist
	}
	cfg.Bespoke = &viewer.Bespoke{OSC: true, Transition: true, Presenter: true, View: r.View, Sync: viewer.SyncParent}
	page, b, err := slides.HTML([]byte(r.Source), cfg)
	res.Missing = m.Missing()
	if err != nil {
		res.Diagnostics = editor.Diagnose(err, r.Path, r.Source)
		return res
	}
	res.Page = page
	res.Scripts = scriptSources(page)
	if r.HTML {
		cfg.HTML = deck.HTMLAllowlist
		if own, _, err := slides.HTML([]byte(r.Source), cfg); err == nil {
			res.Scripts = scriptSources(own)
		}
	}
	for _, s := range b.Deck.Slides {
		res.Lines = append(res.Lines, s.Line)
	}
	return res
}

// Response is every method's answer: its result, or the error that stopped
// it.
type Response struct {
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Methods are what Call answers.
var Methods = map[string]func([]byte) (any, error){
	"render": func(b []byte) (any, error) {
		var r editor.Request
		if err := json.Unmarshal(b, &r); err != nil {
			return nil, err
		}
		return editor.Render(r), nil
	},
	"present": func(b []byte) (any, error) {
		var r PresentRequest
		if err := json.Unmarshal(b, &r); err != nil {
			return nil, err
		}
		return Present(r), nil
	},
	"detect": func(b []byte) (any, error) {
		var r DetectRequest
		if err := json.Unmarshal(b, &r); err != nil {
			return nil, err
		}
		return editor.Detect(r.Source, r.Marp), nil
	},
	"complete": func(b []byte) (any, error) {
		var p Position
		if err := json.Unmarshal(b, &p); err != nil {
			return nil, err
		}
		items := editor.Complete(p.Request, p.Line, p.Character)
		if items == nil {
			items = []editor.Item{}
		}
		return items, nil
	},
	"hover": func(b []byte) (any, error) {
		var p Position
		if err := json.Unmarshal(b, &p); err != nil {
			return nil, err
		}
		return editor.HoverAt(p.Request, p.Line, p.Character), nil
	},
	"version": func([]byte) (any, error) { return Version(), nil },
}

// Call runs a method. It never panics: a panic in WebAssembly would end the
// Go program and every later call with it, so it comes back as an error.
func Call(method, request string) (out string) {
	defer func() {
		if r := recover(); r != nil {
			out = encode(Response{Error: fmt.Sprintf("go-slides: %s panicked: %v", method, r)})
		}
	}()
	m, ok := Methods[method]
	if !ok {
		return encode(Response{Error: "go-slides: no method " + method})
	}
	res, err := m([]byte(request))
	if err != nil {
		return encode(Response{Error: err.Error()})
	}
	return encode(Response{Result: res})
}

func encode(r Response) string {
	b, err := json.Marshal(r)
	if err != nil {
		b, _ = json.Marshal(Response{Error: err.Error()})
	}
	return string(b)
}

// Version is the go-slides module version the extension was built with.
func Version() string {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return "(unknown)"
	}
	for _, d := range bi.Deps {
		if d.Path == "github.com/go-slides/slides" {
			if d.Replace != nil {
				return d.Replace.Version + " (replaced)"
			}
			return d.Version
		}
	}
	return "(devel)"
}
