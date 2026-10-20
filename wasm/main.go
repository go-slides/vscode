//go:build js && wasm

// Command wasm is go-slides for the VS Code extension, compiled with
// GOOS=js GOARCH=wasm. It sets globalThis.goSlides.call(method, json),
// which answers synchronously (the Markdown preview's markdown-it plugin
// cannot wait), and then waits forever so that the function stays alive.
package main

import (
	"runtime/debug"
	"syscall/js"

	"github.com/go-slides/vscode/internal/api"
)

// gcPercent is GOGC for the module; see main.
const gcPercent = 400

func main() {
	// WebAssembly runs Go's collector on the one thread the preview waits
	// on, and a render allocates far more than it keeps: collect less
	// often, for memory the extension host has plenty of.
	debug.SetGCPercent(gcPercent)
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
