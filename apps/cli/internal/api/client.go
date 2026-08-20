// Package api constructs the CLI's generated Connect clients.
package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"runtime/debug"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/electather/nama/apps/cli/internal/config"
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
)

const (
	requestTimeout     = 30 * time.Second
	developmentVersion = "0.0.0-dev"
)

var goPseudoVersionPattern = regexp.MustCompile(
	`^\d+\.\d+\.\d+-(?:[0-9A-Za-z-]+\.)*\d{14}-[0-9a-f]{12,}(?:\+incompatible)?$`,
)

// Clients contains the generated service clients used by CLI operations.
type Clients struct {
	Setup    apiv1.SetupServiceClient
	Auth     apiv1.AuthServiceClient
	Provider apiv1.ProviderServiceClient
}

// NewClients constructs generated Setup, Auth, and Provider clients over httpClient.
func NewClients(httpClient *http.Client, baseURL, bearer string) (*Clients, error) {
	if httpClient == nil {
		return nil, errors.New("HTTP client is required")
	}
	baseURL, insecureTransport, err := config.NormalizeServerURL(baseURL)
	if err != nil {
		return nil, fmt.Errorf("validate server URL: %w", err)
	}

	interceptor := clientInterceptor(bearer)
	client := *httpClient
	effectiveTransport := client.Transport
	if effectiveTransport == nil {
		effectiveTransport = http.DefaultTransport
	}
	if transport, ok := effectiveTransport.(*http.Transport); ok {
		transport = transport.Clone()
		if insecureTransport {
			transport.Proxy = nil
		}
		if transport.TLSClientConfig != nil {
			tlsConfig := transport.TLSClientConfig.Clone()
			tlsConfig.NextProtos = []string{"http/1.1"}
			transport.TLSClientConfig = tlsConfig
		}
		protocols := new(http.Protocols)
		protocols.SetHTTP1(true)
		protocols.SetHTTP2(false)
		transport.Protocols = protocols
		client.Transport = transport
	} else {
		return nil, fmt.Errorf("HTTP client transport %T cannot guarantee HTTP/1", effectiveTransport)
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &Clients{
		Setup:    apiv1.NewSetupServiceClient(&client, baseURL, connect.WithInterceptors(interceptor)),
		Auth:     apiv1.NewAuthServiceClient(&client, baseURL, connect.WithInterceptors(interceptor)),
		Provider: apiv1.NewProviderServiceClient(&client, baseURL, connect.WithInterceptors(interceptor)),
	}, nil
}

func clientInterceptor(bearer string) connect.UnaryInterceptorFunc {
	version := Version()
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
			header := request.Header()
			header.Set("nama-client-name", "nama-cli")
			header.Set("nama-client-platform", "go")
			header.Set("nama-client-version", version)
			if bearer != "" && (request.Spec().Procedure == apiv1.AuthServiceGetCurrentUserProcedure || request.Spec().Procedure == apiv1.AuthServiceSignOutProcedure) {
				header.Set("Authorization", "Bearer "+bearer)
			}
			ctx, cancel := boundedContext(ctx)
			defer cancel()
			return next(ctx, request)
		}
	}
}

// Version returns the client version recorded in Go build information.
func Version() string {
	info, ok := debug.ReadBuildInfo()
	return versionFromBuildInfo(info, ok)
}

func versionFromBuildInfo(info *debug.BuildInfo, ok bool) string {
	if ok && info != nil {
		version := strings.TrimPrefix(info.Main.Version, "v")
		if version != "" && version != "(devel)" && !goPseudoVersionPattern.MatchString(version) {
			return version
		}
	}
	return developmentVersion
}

func boundedContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if deadline, ok := ctx.Deadline(); ok && !deadline.After(time.Now().Add(requestTimeout)) {
		return ctx, noCancel
	}
	return context.WithTimeout(ctx, requestTimeout)
}

func noCancel() {}
