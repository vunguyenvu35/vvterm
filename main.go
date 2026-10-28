package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"

	"vvterm/app"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	dir, err := app.DataDir()
	if err != nil {
		log.Fatalf("data dir: %v", err)
	}
	a, err := app.Build(dir, nil, nil)
	if err != nil {
		log.Fatalf("open data: %v", err)
	}

	err = wails.Run(&options.App{
		Title:     "VVTerm",
		Width:     1280,
		Height:    800,
		MinWidth:  900,
		MinHeight: 600,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 17, G: 19, B: 24, A: 1},
		OnStartup:        a.Startup,
		OnShutdown:       a.Shutdown,
		Mac: &mac.Options{
			TitleBar: mac.TitleBarHiddenInset(),
			About:    &mac.AboutInfo{Title: "VVTerm", Message: "SSH client with an encrypted vault.\nVersion " + app.Version},
		},
		Bind: []interface{}{
			a.Host, a.Vault, a.Session, a.Forward, a.Sync, a.ImportExp, a.Settings, a.System,
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
