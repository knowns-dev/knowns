package cli

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/howznguyen/knowns/internal/registry"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/server"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/tunnel/cloudflared"
	"github.com/howznguyen/knowns/internal/util"
)

var browserCmd = &cobra.Command{
	Use:   "browser",
	Short: "Launch the Knowns web UI",
	Long:  "Start the Knowns HTTP server and optionally open it in a browser.\nCan be launched outside a repo to use the workspace picker.",
	RunE:  runBrowser,
}

// resolveProject determines which project to open using a fallback chain:
//  1. --project <path> flag
//  2. --scan <dirs> flag (pre-populate registry)
//  3. cwd-based .knowns/ discovery
//  4. Picker mode (nil store) — welcome screen handles project selection
func resolveProject(cmd *cobra.Command) (store *storage.Store, projectRoot string) {
	projectFlag, _ := cmd.Flags().GetString("project")
	scanFlag, _ := cmd.Flags().GetString("scan")

	// 1. Explicit --project flag
	if projectFlag != "" {
		absPath, err := filepath.Abs(projectFlag)
		if err == nil {
			knDir := filepath.Join(absPath, ".knowns")
			store = storage.NewStore(knDir)
			projectRoot = absPath
			return
		}
	}

	// 2. --scan flag: pre-populate registry before resolution
	if scanFlag != "" {
		dirs := strings.Split(scanFlag, ",")
		for i := range dirs {
			dirs[i] = strings.TrimSpace(dirs[i])
		}
		reg := registry.NewRegistry()
		if err := reg.Load(); err == nil {
			added, _ := reg.Scan(dirs)
			if len(added) > 0 {
				fmt.Printf("  %s  Discovered %d project(s)\n", StyleInfo.Render("⊕"), len(added))
			}
		}
	}

	// 3. Try cwd-based discovery
	s, err := getStoreErr()
	if err == nil {
		store = s
		projectRoot = filepath.Dir(s.Root)
		return
	}

	// 4. Picker mode — no project found in cwd
	return nil, ""
}

const defaultBrowserPort = 6420
const maxBrowserPortAttempts = 10

func runBrowser(cmd *cobra.Command, args []string) error {
	port, _ := cmd.Flags().GetInt("port")
	openFlag, _ := cmd.Flags().GetBool("open")
	noOpen, _ := cmd.Flags().GetBool("no-open")
	restart, _ := cmd.Flags().GetBool("restart")
	dev, _ := cmd.Flags().GetBool("dev")
	watchFlag, _ := cmd.Flags().GetBool("watch")
	tunnelFlag, _ := cmd.Flags().GetBool("tunnel")

	store, projectRoot := resolveProject(cmd)

	if port == 0 {
		port = defaultBrowserPort
	}

	// Auto-register this project in the global registry (only if we have a project).
	if store != nil {
		reg := registry.NewRegistry()
		if err := reg.Load(); err == nil {
			if p, err := reg.Add(projectRoot); err == nil {
				_ = reg.SetActive(p.ID)
			}
		}
	}

	// Handle restart: attempt to stop existing server first
	if restart {
		fmt.Printf("%s Attempting to stop existing server on port %d...\n", StyleWarning.Render("↻"), port)
		stopExistingServer(port)
	}

	listener, selectedPort, err := bindBrowserPort(port, maxBrowserPortAttempts)
	if err != nil {
		return err
	}
	if selectedPort != port {
		fmt.Printf("  %s  Port %d is busy, using %d instead\n", StyleWarning.Render("↷"), port, selectedPort)
	}
	port = selectedPort

	// Determine whether to open browser: --open enables, --no-open disables
	shouldOpen := openFlag && !noOpen

	srv := server.NewServer(store, projectRoot, port, server.Options{Dev: dev})

	url := fmt.Sprintf("http://localhost:%d", port)
	fmt.Println()
	fmt.Printf("  %s  %s %s\n", StyleSuccess.Render("●"), StyleBold.Render("Knowns"), StyleDim.Render("v"+util.Version))
	fmt.Println()
	fmt.Printf("  %s  %s\n", StyleInfo.Render("→"), StyleBold.Render(url))
	if ip := getLocalIP(); ip != "" {
		fmt.Printf("  %s  %s\n", StyleInfo.Render("→"), StyleInfo.Render(fmt.Sprintf("http://%s:%d", ip, port)))
	}
	if projectRoot != "" {
		fmt.Printf("  %s  %s\n", StyleInfo.Render("⌁"), StyleBold.Render(projectRoot))
	} else {
		fmt.Printf("  %s  %s\n", StyleWarning.Render("◇"), StyleWarning.Render("No project — workspace picker mode"))
	}
	fmt.Println()

	if tunnelFlag {
		if err := startTunnel(port); err != nil {
			fmt.Printf("  %s  %s\n", StyleError.Render("✗"), StyleError.Render("tunnel failed"))
			for _, line := range strings.Split(err.Error(), "\n") {
				fmt.Printf("     %s\n", StyleDim.Render(line))
			}
			fmt.Println()
		}
	}

	// Start file watcher if --watch is enabled
	if watchFlag && store != nil && projectRoot != "" {
		ctx, cancelWatcher := context.WithCancel(context.Background())
		defer cancelWatcher()
		go func() {
			if err := StartCodeWatcher(ctx, store, projectRoot, 1500); err != nil {
				fmt.Fprintf(os.Stderr, "watcher error: %v\n", err)
			}
		}()
		fmt.Printf("  %s  %s\n", StyleInfo.Render("◎"), StyleDim.Render("file watcher enabled"))
	}

	// Auto-ingest code on startup if semantic search is configured but no code chunks exist.
	if store != nil && projectRoot != "" {
		go func() {
			db := store.SemanticDB()
			if db == nil {
				return
			}
			var count int
			_ = db.QueryRow("SELECT COUNT(*) FROM chunks WHERE type='code'").Scan(&count)
			db.Close()
			if count == 0 {
				search.BestEffortIndexAll(store, projectRoot)
			}
		}()
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.StartWithListener(listener)
	}()

	if shouldOpen {
		if err := waitForHTTPServer(port, 3*time.Second); err != nil {
			return <-errCh
		}
		openBrowser(url)
	}

	return <-errCh
}

func getLocalIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return ""
	}
	defer conn.Close()
	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		return ""
	}
	return addr.IP.String()
}

func bindBrowserPort(startPort int, attempts int) (net.Listener, int, error) {
	for offset := 0; offset < attempts; offset++ {
		port := startPort + offset
		// First check if anything is already listening (catches IPv4/IPv6 conflicts)
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
		if err == nil {
			conn.Close()
			continue // port in use by another process
		}
		listener, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", port))
		if err == nil {
			return listener, port, nil
		}
		if !isAddrInUse(err) {
			return nil, 0, fmt.Errorf("check port %d: %w", port, err)
		}
	}
	return nil, 0, fmt.Errorf("no available port in range %d-%d", startPort, startPort+attempts-1)
}

func waitForHTTPServer(port int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("server on port %d did not become ready in time", port)
}

func isAddrInUse(err error) bool {
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "address already in use") || strings.Contains(msg, "only one usage of each socket address") {
		return true
	}

	var opErr *net.OpError
	if !errors.As(err, &opErr) {
		return false
	}
	if errors.Is(opErr.Err, syscall.EADDRINUSE) {
		return true
	}
	var sysErr *os.SyscallError
	if !errors.As(opErr.Err, &sysErr) {
		return false
	}
	return errors.Is(sysErr.Err, syscall.EADDRINUSE)
}

// stopExistingServer sends a shutdown request to any existing server on the
// given port and waits for the port to be released. Returns true if the port
// was freed, false if no server was found or the stop timed out.
func stopExistingServer(port int) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Post(
		fmt.Sprintf("http://localhost:%d/api/shutdown", port),
		"application/json", nil,
	)
	if err != nil {
		fmt.Println(StyleDim.Render("No existing server found."))
		return false
	}
	resp.Body.Close()

	fmt.Println(StyleWarning.Render("Existing server detected.") + " Waiting for shutdown...")

	// Poll until the port is released (max ~3s).
	for i := 0; i < 10; i++ {
		conn, dialErr := net.DialTimeout("tcp",
			fmt.Sprintf("localhost:%d", port), 200*time.Millisecond)
		if dialErr != nil {
			fmt.Println(StyleSuccess.Render("Previous server stopped."))
			return true // Port released
		}
		conn.Close()
		time.Sleep(300 * time.Millisecond)
	}

	fmt.Println(StyleWarning.Render("Timed out waiting for previous server to stop."))
	return false
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	}
	if cmd != nil {
		cmd.Start()
	}
}

func init() {
	browserCmd.Flags().Int("port", 0, "HTTP server port (default: 6420; tries next ports if busy)")
	browserCmd.Flags().Bool("open", false, "Open browser after starting")
	browserCmd.Flags().Bool("no-open", false, "Don't automatically open browser")
	browserCmd.Flags().Bool("restart", false, "Restart server if already running")
	browserCmd.Flags().Bool("dev", false, "Enable development mode (verbose logging)")
	browserCmd.Flags().String("project", "", "Project path to open directly")
	browserCmd.Flags().String("scan", "", "Comma-separated directories to scan for projects")
	browserCmd.Flags().Bool("watch", false, "Enable file watcher for auto-indexing on code changes")
	browserCmd.Flags().Bool("tunnel", false, "Expose via a Cloudflare Quick Tunnel (requires cloudflared)")

	rootCmd.AddCommand(browserCmd)
}

func startTunnel(port int) error {
	d := cloudflared.NewDaemon(port)
	if err := d.EnsureRunning(); err != nil {
		return err
	}
	url, err := d.PublicURL()
	if err != nil {
		return fmt.Errorf("tunnel started but no URL captured: %w", err)
	}
	tag := "reused"
	if d.StartedByUs() {
		tag = "new"
	}
	fmt.Printf("  %s  %s  %s\n",
		StyleSuccess.Render("⇄"),
		StyleBold.Render(url),
		StyleDim.Render("(cloudflared "+tag+")"))
	fmt.Println()
	return nil
}
