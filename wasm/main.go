//go:build js && wasm

// Command wasm is go-slides for the VS Code extension, compiled with
// GOOS=js GOARCH=wasm. It sets globalThis.goSlides.call(method, json),
// which answers synchronously (the Markdown preview's markdown-it plugin
// cannot wait), and then waits forever so that the function stays alive.
package main

import (
	"syscall/js"

	"github.com/go-slides/vscode/internal/api"
)

func main() {
	// Go's default GOGC: WebAssembly runs the collector on the one thread
	// the preview waits on, but a render of the 100-slide deck allocates
	// 5.7 MB, and the preview after an edit (24 ms) matches Marp's at the
	// default. The GOGC=400 override is gone.
	call := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) != 2 || args[0].Type() != js.TypeString || args[1].Type() != js.TypeString {
			return `{"error":"go-slides: call(method, json) takes two strings"}`
		}
		return api.Call(args[0].String(), args[1].String())
	})
	js.Global().Set("goSlides", js.ValueOf(map[string]any{
		"call":    call,
		"version": api.Version(),
	}))
	select {}
}
