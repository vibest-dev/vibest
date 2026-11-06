module vibest-desktop

go 1.27.2

require (
	github.com/ebitengine/purego v0.11.1
	github.com/egoist/mygo v0.6.0
	golang.org/x/text v0.43.0
)

require (
	github.com/go-text/typesetting v0.3.5 // indirect
	golang.org/x/image v0.46.0 // indirect
)

replace github.com/egoist/mygo => ./third_party/mygo
