package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func execute(t *testing.T, args ...string) (string, error) {
	t.Helper()
	c := RootCmd()
	var out bytes.Buffer
	c.SetOut(&out)
	c.SetErr(&out)
	c.SetArgs(args)
	err := c.Execute()
	return out.String(), err
}

func TestGeneratedSources(t *testing.T) {
	dir := t.TempDir()
	if _, err := execute(t, "--root", dir, "--skip-wasm"); err != nil {
		t.Fatal(err)
	}
	js, err := os.ReadFile(filepath.Join(dir, "src", "gen", "wasm_exec.js"))
	if err != nil || !bytes.Contains(js, []byte("globalThis.Go")) {
		t.Fatalf("wasm_exec.js: %v", err)
	}
	p, err := os.ReadFile(filepath.Join(dir, "media", "preview.js"))
	if err != nil || !strings.Contains(string(p), "data-fit-content") || !strings.Contains(string(p), "vscode.markdown.updateContent") {
		t.Fatalf("preview.js: %v\n%s", err, p)
	}
}

// TestModule compiles the real module of this repository, in place (dist/
// and src/gen/ are generated and ignored by git), and checks the size
// report and the budget.
func TestModule(t *testing.T) {
	if testing.Short() {
		t.Skip("compiles the WebAssembly module")
	}
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	out, err := execute(t, "--root", root)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "gzip") || !strings.Contains(out, "brotli") {
		t.Fatalf("no size report: %s", out)
	}
	if _, err := execute(t, "--root", root, "--max-brotli", "1"); err == nil || !strings.Contains(err.Error(), "budget") {
		t.Fatalf("a 1-byte budget passed: %v", err)
	}
}

func TestErrors(t *testing.T) {
	if _, err := execute(t, "--go", filepath.Join(t.TempDir(), "no-go")); err == nil {
		t.Fatal("a missing go command passed")
	}
	if _, err := execute(t, "extra"); err == nil {
		t.Fatal("an argument was accepted")
	}
	// A file where the generated directory should be.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "src"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := execute(t, "--root", dir, "--skip-wasm"); err == nil {
		t.Fatal("writing under a file passed")
	}
}

func TestMeasure(t *testing.T) {
	s := Measure(bytes.Repeat([]byte("go-slides "), 10000))
	if s.Raw != 100000 || s.Gzip >= s.Raw || s.Brotli >= s.Raw || s.Brotli == 0 {
		t.Fatalf("%+v", s)
	}
}

func TestMeasureCommand(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.bin")
	if err := os.WriteFile(p, bytes.Repeat([]byte{7}, 1<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := execute(t, "measure", p)
	if err != nil || !strings.Contains(out, "1.00 MiB raw") {
		t.Fatalf("%q %v", out, err)
	}
	if _, err := execute(t, "measure", p+".missing"); err == nil {
		t.Fatal("a missing file measured")
	}
}

func TestMainExits(t *testing.T) {
	old := osExit
	defer func() { osExit = old }()
	code := -1
	osExit = func(c int) { code = c }
	os.Args = []string{"build", "--bogus"}
	main()
	if code != 1 {
		t.Fatalf("exit %d", code)
	}
}
