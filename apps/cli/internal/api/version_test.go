package api

import (
	"runtime/debug"
	"testing"
)

func TestVersionNormalizesReleasedBuildsAndDevelopmentFallback(t *testing.T) {
	for _, test := range []struct {
		name string
		info *debug.BuildInfo
		ok   bool
		want string
	}{
		{name: "missing build info", want: "0.0.0-dev"},
		{name: "development build", info: &debug.BuildInfo{Main: debug.Module{Version: "(devel)"}}, ok: true, want: "0.0.0-dev"},
		{name: "empty module version", info: &debug.BuildInfo{}, ok: true, want: "0.0.0-dev"},
		{name: "clean source pseudo-version", info: &debug.BuildInfo{Main: debug.Module{Version: "v0.0.0-20260820100035-1a18319c5241"}}, ok: true, want: "0.0.0-dev"},
		{name: "dirty source pseudo-version", info: &debug.BuildInfo{Main: debug.Module{Version: "v0.0.0-20260820100035-1a18319c5241+dirty"}}, ok: true, want: "0.0.0-dev"},
		{name: "tag-derived pseudo-version", info: &debug.BuildInfo{Main: debug.Module{Version: "v1.2.4-0.20260820100035-1a18319c5241"}}, ok: true, want: "0.0.0-dev"},
		{name: "zero prerelease", info: &debug.BuildInfo{Main: debug.Module{Version: "v0.0.0-rc.1"}}, ok: true, want: "0.0.0-rc.1"},
		{name: "released module version", info: &debug.BuildInfo{Main: debug.Module{Version: "v1.2.3"}}, ok: true, want: "1.2.3"},
		{name: "released version without prefix", info: &debug.BuildInfo{Main: debug.Module{Version: "1.2.3-rc.1"}}, ok: true, want: "1.2.3-rc.1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := versionFromBuildInfo(test.info, test.ok); got != test.want {
				t.Errorf("version = %q, want %q", got, test.want)
			}
		})
	}

	if got, want := Version(), "0.0.0-dev"; got != want {
		t.Errorf("test binary version = %q, want %q", got, want)
	}
}
