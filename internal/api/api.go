// Package api is the extension's one entry into Go: a method name and a
// JSON request in, a JSON response out. The WebAssembly module (package
// wasm) exposes Call to JavaScript; everything it does is go-slides'
// editor package, so the TypeScript side never parses, renders or decides.
package api

import (
	"encoding/json"
	"fmt"
	"runtime/debug"

	"github.com/go-slides/slides/editor"
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
