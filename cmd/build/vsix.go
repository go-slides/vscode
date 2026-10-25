package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"image/png"
	"io"
	"path"
	"slices"
	"strings"

	"github.com/spf13/cobra"
)

// The Marketplace's categories (code.visualstudio.com/api/references/extension-manifest).
var marketplaceCategories = []string{
	"Programming Languages", "Snippets", "Linters", "Themes", "Debuggers", "Formatters", "Keymaps",
	"SCM Providers", "Other", "Extension Packs", "Language Packs", "Data Science", "Machine Learning",
	"Visualization", "Notebooks", "Education", "Testing",
}

// vsixRequired are the files a .vsix of this extension must hold, under extension/.
var vsixRequired = []string{
	"package.json", "readme.md", "changelog.md",
	"dist/node.js", "dist/web.js", "dist/slides.wasm",
	"media/preview.js", "media/go-slides-preview.css", "media/icon.png",
}

type manifest struct {
	Name          string `json:"name"`
	DisplayName   string `json:"displayName"`
	Description   string `json:"description"`
	Version       string `json:"version"`
	Publisher     string `json:"publisher"`
	License       string `json:"license"`
	Icon          string `json:"icon"`
	Main          string `json:"main"`
	Browser       string `json:"browser"`
	Homepage      string `json:"homepage"`
	GalleryBanner struct {
		Color string `json:"color"`
		Theme string `json:"theme"`
	} `json:"galleryBanner"`
	Repository struct {
		URL string `json:"url"`
	} `json:"repository"`
	Bugs struct {
		URL string `json:"url"`
	} `json:"bugs"`
	Categories []string `json:"categories"`
	Keywords   []string `json:"keywords"`
	Engines    struct {
		VSCode string `json:"vscode"`
	} `json:"engines"`
}

// VerifyVSIX checks a packaged extension for what a Marketplace listing needs and
// what must not travel in it, and returns every problem found.
func VerifyVSIX(vsix []byte, tag string, maxBytes int64) []string {
	var bad []string
	fail := func(format string, a ...any) { bad = append(bad, fmt.Sprintf(format, a...)) }
	if maxBytes > 0 && int64(len(vsix)) > maxBytes {
		fail("the .vsix is %d bytes, over the %d budget", len(vsix), maxBytes)
	}
	zr, err := zip.NewReader(bytes.NewReader(vsix), int64(len(vsix)))
	if err != nil {
		return append(bad, "not a zip: "+err.Error())
	}
	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[strings.ToLower(f.Name)] = f
		name := strings.ToLower(f.Name)
		base := path.Base(name)
		switch {
		case strings.HasSuffix(name, ".map"):
			fail("a source map travels in the .vsix: %s", f.Name)
		case strings.Contains(name, "/node_modules/"), strings.Contains(name, "/src/"), strings.Contains(name, "/test/"), strings.Contains(name, "/.github/"), strings.Contains(name, "/cmd/"), strings.Contains(name, "/wasm/"), strings.Contains(name, "/internal/"):
			fail("a development file travels in the .vsix: %s", f.Name)
		case strings.HasSuffix(name, ".go"), strings.HasSuffix(name, ".ts") && !strings.HasSuffix(name, ".d.ts"), base == "go.mod", base == "go.sum", base == "package-lock.json", base == "tsconfig.json":
			fail("a source file travels in the .vsix: %s", f.Name)
		case base == ".env", base == ".npmrc", base == ".netrc", strings.HasSuffix(base, ".pem"), strings.HasSuffix(base, ".key"), strings.HasPrefix(base, "id_rsa"), strings.HasPrefix(base, ".env."):
			fail("a credential-shaped file travels in the .vsix: %s", f.Name)
		}
	}
	read := func(name string) []byte {
		f := files["extension/"+strings.ToLower(name)]
		if f == nil {
			return nil
		}
		rc, err := f.Open()
		if err != nil {
			return nil
		}
		defer rc.Close()
		b, _ := io.ReadAll(io.LimitReader(rc, 64<<20))
		return b
	}
	for _, name := range vsixRequired {
		if files["extension/"+strings.ToLower(name)] == nil {
			fail("the .vsix lacks extension/%s", name)
		}
	}
	if !slices.ContainsFunc(zr.File, func(f *zip.File) bool { return strings.HasPrefix(strings.ToLower(f.Name), "extension/license") }) {
		fail("the .vsix lacks a LICENSE")
	}
	var m manifest
	if err := json.Unmarshal(read("package.json"), &m); err != nil {
		return append(bad, "package.json: "+err.Error())
	}
	need := func(field, value string) {
		if strings.TrimSpace(value) == "" {
			fail("package.json has no %s", field)
		}
	}
	need("name", m.Name)
	need("displayName", m.DisplayName)
	need("description", m.Description)
	need("publisher", m.Publisher)
	need("repository.url", m.Repository.URL)
	need("homepage", m.Homepage)
	need("bugs.url", m.Bugs.URL)
	need("engines.vscode", m.Engines.VSCode)
	if m.License != "BSD-3-Clause" {
		fail("license is %q, want BSD-3-Clause", m.License)
	}
	if tag != "" && m.Version != strings.TrimPrefix(tag, "v") {
		fail("package.json says version %s, the release is %s", m.Version, tag)
	}
	for _, c := range m.Categories {
		if !slices.Contains(marketplaceCategories, c) {
			fail("category %q is not one the Marketplace has", c)
		}
	}
	if len(m.Categories) == 0 {
		fail("package.json has no categories")
	}
	if len(m.Keywords) == 0 || len(m.Keywords) > 30 {
		fail("%d keywords: the Marketplace takes 1 to 30", len(m.Keywords))
	}
	if !strings.HasPrefix(m.GalleryBanner.Color, "#") || (m.GalleryBanner.Theme != "dark" && m.GalleryBanner.Theme != "light") {
		fail("galleryBanner is %+v: a #color and a theme, dark or light", m.GalleryBanner)
	}
	for field, rel := range map[string]string{"main": m.Main, "browser": m.Browser} {
		if rel != "" && files["extension/"+strings.ToLower(strings.TrimPrefix(rel, "./"))] == nil {
			fail("%s is %s, which the .vsix lacks", field, rel)
		}
	}
	if img := read(strings.TrimPrefix(m.Icon, "./")); img == nil {
		fail("icon %q is not in the .vsix", m.Icon)
	} else if cfg, err := png.DecodeConfig(bytes.NewReader(img)); err != nil {
		fail("the icon is not a PNG: %v", err)
	} else if cfg.Width < 128 || cfg.Height < 128 || cfg.Width != cfg.Height {
		fail("the icon is %dx%d: the Marketplace wants a square of 128 px or more", cfg.Width, cfg.Height)
	}
	if m.Version != "" && !bytes.Contains(read("changelog.md"), []byte("## "+m.Version+"\n")) {
		fail("CHANGELOG.md has no entry for %s", m.Version)
	}
	if bytes.Contains(read("readme.md"), []byte("](media/")) || bytes.Contains(read("readme.md"), []byte("](./")) {
		fail("README.md links a relative file: the Marketplace page has no such path")
	}
	return bad
}

func verifyCommand() *cobra.Command {
	var tag string
	var max int64
	c := &cobra.Command{
		Use:   "verify-vsix file.vsix",
		Short: "Check a .vsix for what the Marketplace and Open VSX need, and for what must not travel in it",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			b, err := readFile(args[0])
			if err != nil {
				return err
			}
			bad := VerifyVSIX(b, tag, max)
			for _, p := range bad {
				fmt.Fprintln(cmd.ErrOrStderr(), "verify-vsix:", p)
			}
			if len(bad) > 0 {
				return fmt.Errorf("%d problems in %s", len(bad), args[0])
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%s: %d bytes, listing metadata and contents are in order\n", args[0], len(b))
			return nil
		},
	}
	c.Flags().StringVar(&tag, "tag", "", "the release tag (v0.4.0): package.json's version must be it")
	c.Flags().Int64Var(&max, "max-bytes", 16<<20, "fail when the .vsix is larger than this (0: no budget)")
	return c
}
