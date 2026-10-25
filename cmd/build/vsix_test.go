package main

import (
	"archive/zip"
	"bytes"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func pngOf(w, h int) []byte {
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		panic(err)
	}
	return b.Bytes()
}

const goodManifest = `{
 "name": "go-slides", "displayName": "go-slides", "description": "d", "version": "0.4.0", "publisher": "go-slides",
 "license": "BSD-3-Clause", "icon": "media/icon.png", "galleryBanner": {"color": "#1E1B4B", "theme": "dark"},
 "repository": {"type": "git", "url": "https://github.com/go-slides/vscode"}, "homepage": "https://x", "bugs": {"url": "https://x/issues"},
 "categories": ["Visualization", "Education", "Other"], "keywords": ["slides"], "engines": {"vscode": "^1.101.0"},
 "main": "./dist/node.js", "browser": "./dist/web.js"}`

// vsix builds a package from the good files, with changes: a nil value removes a
// file, anything else sets it.
func vsix(t *testing.T, change map[string][]byte) []byte {
	t.Helper()
	files := map[string][]byte{
		"extension/package.json":                []byte(goodManifest),
		"extension/readme.md":                   []byte("# go-slides\n"),
		"extension/changelog.md":                []byte("# Changelog\n\n## 0.4.0\n\n- x\n"),
		"extension/LICENSE.txt":                 []byte("BSD"),
		"extension/dist/node.js":                []byte("x"),
		"extension/dist/web.js":                 []byte("x"),
		"extension/dist/slides.wasm":            []byte("x"),
		"extension/media/preview.js":            []byte("x"),
		"extension/media/go-slides-preview.css": []byte("x"),
		"extension/media/icon.png":              pngOf(256, 256),
		"[Content_Types].xml":                   []byte("x"),
	}
	for k, v := range change {
		if v == nil {
			delete(files, k)
		} else {
			files[k] = v
		}
	}
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	for k, v := range files {
		w, err := zw.Create(k)
		if err != nil {
			t.Fatal(err)
		}
		w.Write(v)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func problems(t *testing.T, change map[string][]byte, tag string) string {
	t.Helper()
	return strings.Join(VerifyVSIX(vsix(t, change), tag, 0), "\n")
}

func TestVerifyVSIXAcceptsAGoodPackage(t *testing.T) {
	if p := problems(t, nil, "v0.4.0"); p != "" {
		t.Fatal(p)
	}
}

func TestVerifyVSIXRefusesWhatTheListingCannotTake(t *testing.T) {
	manifest := func(from, to string) map[string][]byte {
		return map[string][]byte{"extension/package.json": []byte(strings.Replace(goodManifest, from, to, 1))}
	}
	cases := []struct {
		name   string
		change map[string][]byte
		tag    string
		want   string
	}{
		{"no icon file", map[string][]byte{"extension/media/icon.png": nil}, "", "lacks extension/media/icon.png"},
		{"a small icon", map[string][]byte{"extension/media/icon.png": pngOf(64, 64)}, "", "128 px or more"},
		{"a wide icon", map[string][]byte{"extension/media/icon.png": pngOf(256, 128)}, "", "square"},
		{"an icon that is not a PNG", map[string][]byte{"extension/media/icon.png": []byte("<svg/>")}, "", "not a PNG"},
		{"the wrong version", nil, "v0.5.0", "version 0.4.0, the release is v0.5.0"},
		{"no changelog entry", map[string][]byte{"extension/changelog.md": []byte("## 0.3.0\n")}, "", "no entry for 0.4.0"},
		{"another license", manifest("BSD-3-Clause", "MIT"), "", "want BSD-3-Clause"},
		{"a category the Marketplace does not have", manifest(`"Education"`, `"Slides"`), "", `"Slides"`},
		{"no gallery banner", manifest(`"#1E1B4B"`, `""`), "", "galleryBanner"},
		{"no repository", manifest(`"url": "https://github.com/go-slides/vscode"`, `"url": ""`), "", "repository.url"},
		{"no keywords", manifest(`"keywords": ["slides"]`, `"keywords": []`), "", "0 keywords"},
		{"a missing entry point", map[string][]byte{"extension/dist/web.js": nil}, "", "lacks extension/dist/web.js"},
		{"a missing module", map[string][]byte{"extension/dist/slides.wasm": nil}, "", "lacks extension/dist/slides.wasm"},
		{"no license file", map[string][]byte{"extension/LICENSE.txt": nil}, "", "lacks a LICENSE"},
		{"a source map", map[string][]byte{"extension/dist/node.js.map": []byte("{}")}, "", "source map"},
		{"the sources", map[string][]byte{"extension/src/extension.ts": []byte("x")}, "", "development file"},
		{"node_modules", map[string][]byte{"extension/node_modules/x/index.js": []byte("x")}, "", "development file"},
		{"Go sources", map[string][]byte{"extension/wasm/main.go": []byte("x")}, "", "development file"},
		{"a token file", map[string][]byte{"extension/.env": []byte("VSCE_PAT=x")}, "", "credential-shaped"},
		{"a key", map[string][]byte{"extension/deploy.pem": []byte("x")}, "", "credential-shaped"},
		{"a relative link in the README", map[string][]byte{"extension/readme.md": []byte("![x](media/icon.png)\n")}, "", "relative"},
	}
	for _, c := range cases {
		if got := problems(t, c.change, c.tag); !strings.Contains(got, c.want) {
			t.Errorf("%s: want a problem naming %q, got %q", c.name, c.want, got)
		}
	}
}

func TestVerifyVSIXBudgetAndGarbage(t *testing.T) {
	if got := VerifyVSIX(vsix(t, nil), "", 10); len(got) == 0 || !strings.Contains(got[0], "budget") {
		t.Fatalf("budget: %v", got)
	}
	if got := VerifyVSIX([]byte("not a zip"), "", 0); len(got) == 0 || !strings.Contains(got[len(got)-1], "not a zip") {
		t.Fatalf("garbage: %v", got)
	}
	if got := VerifyVSIX(vsix(t, map[string][]byte{"extension/package.json": []byte("{")}), "", 0); len(got) == 0 || !strings.Contains(got[len(got)-1], "package.json") {
		t.Fatalf("bad manifest: %v", got)
	}
	if got := VerifyVSIX(vsix(t, map[string][]byte{"extension/package.json": nil}), "", 0); len(got) == 0 {
		t.Fatalf("no manifest: %v", got)
	}
}

func TestVerifyCommand(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.vsix")
	if err := os.WriteFile(good, vsix(t, nil), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := execute(t, "verify-vsix", good, "--tag", "v0.4.0"); err != nil || !strings.Contains(out, "in order") {
		t.Fatalf("%q %v", out, err)
	}
	if out, err := execute(t, "verify-vsix", good, "--tag", "v9.9.9"); err == nil || !strings.Contains(out, "v9.9.9") {
		t.Fatalf("a wrong tag passed: %q %v", out, err)
	}
	if _, err := execute(t, "verify-vsix", filepath.Join(dir, "none.vsix")); err == nil {
		t.Fatal("a missing file passed")
	}
	if _, err := execute(t, "verify-vsix"); err == nil {
		t.Fatal("no file passed")
	}
}
