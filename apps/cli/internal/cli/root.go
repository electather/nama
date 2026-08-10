package cli

import (
	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
	"github.com/spf13/cobra"
)

var _ apiv1.HealthServiceClient

func NewRootCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "nama",
		Short: "Manage a Nama server",
		Args:  cobra.NoArgs,
	}
}
