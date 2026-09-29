package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/howznguyen/knowns/internal/codegen"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/spf13/cobra"
)

var templateCmd = &cobra.Command{
	Use:   "template",
	Short: "Manage code generation templates",
	Long:  "List, view, run, and create code generation templates.",
	// Allow 'knowns template <name>' as a shorthand for 'knowns template view <name>'
	Args: cobra.ArbitraryArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		if len(args) == 0 {
			return cmd.Help()
		}
		// Treat first arg as template name → delegate to view
		return runTemplateView(cmd, args[0])
	},
}

// --- template list ---

var templateListCmd = &cobra.Command{
	Use:   "list",
	Short: "List available templates",
	RunE:  runTemplateList,
}

func runTemplateList(cmd *cobra.Command, args []string) error {
	store := getStore()

	localOnly, _ := cmd.Flags().GetBool("local")
	importedOnly, _ := cmd.Flags().GetBool("imported")

	templates, err := store.Templates.List()
	if err != nil {
		return fmt.Errorf("list templates: %w", err)
	}

	// Apply filters
	if localOnly || importedOnly {
		filtered := make([]*models.Template, 0, len(templates))
		for _, t := range templates {
			if localOnly && t.IsImported {
				continue
			}
			if importedOnly && !t.IsImported {
				continue
			}
			filtered = append(filtered, t)
		}
		templates = filtered
	}

	plain := isPlain(cmd)
	jsonOut := isJSON(cmd)

	if jsonOut {
		printJSON(templates)
		return nil
	}

	if len(templates) == 0 {
		fmt.Println(StyleDim.Render("No templates found."))
		return nil
	}

	if plain {
		for _, t := range templates {
			displayName := t.Name
			if t.IsImported && t.ImportName != "" {
				displayName = t.ImportName + "/" + t.Name
			}
			fmt.Printf("TEMPLATE: %s\n", displayName)
			if t.Description != "" {
				fmt.Printf("  DESCRIPTION: %s\n", t.Description)
			}
			if t.IsImported {
				fmt.Printf("  IMPORTED FROM: %s\n", t.ImportName)
			}
			if t.Doc != "" {
				fmt.Printf("  DOC: %s\n", t.Doc)
			}
			if len(t.Prompts) > 0 {
				vars := make([]string, len(t.Prompts))
				for i, p := range t.Prompts {
					vars[i] = p.Name
				}
				fmt.Printf("  VARIABLES: %s\n", strings.Join(vars, ", "))
			}
			fmt.Println()
		}
	} else {
		fmt.Printf("%s  %s  %s\n",
			StyleBold.Render(fmt.Sprintf("%-30s", "NAME")),
			StyleBold.Render(fmt.Sprintf("%-40s", "DESCRIPTION")),
			StyleBold.Render("TYPE"))
		fmt.Println(RenderSeparator(80))
		for _, t := range templates {
			displayName := t.Name
			if t.IsImported && t.ImportName != "" {
				displayName = t.ImportName + "/" + t.Name
			}
			if len(displayName) > 28 {
				displayName = displayName[:25] + "..."
			}
			desc := t.Description
			if len(desc) > 38 {
				desc = desc[:35] + "..."
			}
			tmplType := StyleDim.Render("local")
			if t.IsImported {
				tmplType = StyleInfo.Render("imported")
			}
			fmt.Printf("%-30s  %-40s  %s\n", displayName, desc, tmplType)
		}
	}
	return nil
}

// --- template view ---

var templateViewCmd = &cobra.Command{
	Use:   "view <name>",
	Short: "View template details",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runTemplateView(cmd, args[0])
	},
}

func runTemplateView(cmd *cobra.Command, name string) error {
	store := getStore()

	tmpl, err := store.Templates.Get(name)
	if err != nil {
		return fmt.Errorf("template %q not found", name)
	}

	jsonOut := isJSON(cmd)
	plain := isPlain(cmd)

	if jsonOut {
		printJSON(tmpl)
		return nil
	}

	if plain {
		printTemplatePlain(tmpl)
	} else {
		printTemplateDetailed(tmpl)
	}

	return nil
}

// --- template run ---

var templateRunCmd = &cobra.Command{
	Use:   "run <name>",
	Short: "Run a code generation template",
	Args:  cobra.ExactArgs(1),
	RunE:  runTemplateRun,
}

func runTemplateRun(cmd *cobra.Command, args []string) error {
	name := args[0]
	store := getStore()

	tmpl, err := store.Templates.Get(name)
	if err != nil {
		return fmt.Errorf("template %q not found", name)
	}

	dryRun, _ := cmd.Flags().GetBool("dry-run")
	varFlags, _ := cmd.Flags().GetStringArray("var")

	// Parse key=value variable flags.
	vars := make(map[string]string)
	for _, v := range varFlags {
		idx := strings.Index(v, "=")
		if idx == -1 {
			return fmt.Errorf("invalid variable format %q: expected key=value", v)
		}
		vars[v[:idx]] = v[idx+1:]
	}

	// Validate required prompts have values provided.
	for _, p := range tmpl.Prompts {
		if p.Validate == "required" {
			if _, ok := vars[p.Name]; !ok {
				// Use the initial/default value if available.
				if p.Initial != "" {
					vars[p.Name] = p.Initial
				} else {
					return fmt.Errorf("required variable %q not provided (use -v %s=<value>)", p.Name, p.Name)
				}
			}
		}
		// Set defaults for optional prompts that were not provided.
		if _, ok := vars[p.Name]; !ok && p.Initial != "" {
			vars[p.Name] = p.Initial
		}
	}

	// Determine the project root (one level up from .knowns/).
	projectRoot := store.ProjectRoot
	engine := codegen.NewEngine(projectRoot)

	result, err := engine.Run(tmpl, vars, dryRun)
	if err != nil {
		return fmt.Errorf("run template: %w", err)
	}

	jsonOut := isJSON(cmd)
	if jsonOut {
		printJSON(result)
		return nil
	}

	if dryRun {
		fmt.Println(StyleWarning.Render("Dry run") + StyleDim.Render(" — no files were written."))
		fmt.Println()
	}

	if len(result.Created) > 0 {
		fmt.Println(StyleSuccess.Render("Created:"))
		for _, f := range result.Created {
			fmt.Printf("  %s %s\n", StyleSuccess.Render("+"), f)
		}
	}
	if len(result.Modified) > 0 {
		fmt.Println(StyleWarning.Render("Modified:"))
		for _, f := range result.Modified {
			fmt.Printf("  %s %s\n", StyleWarning.Render("~"), f)
		}
	}
	if len(result.Skipped) > 0 {
		fmt.Println(StyleDim.Render("Skipped:"))
		for _, f := range result.Skipped {
			fmt.Printf("  %s %s\n", StyleDim.Render("-"), f)
		}
	}

	if !dryRun && tmpl.Messages != nil && tmpl.Messages.Success != "" {
		fmt.Println()
		// Render the success message through the template engine so
		// variables like {{name}} are replaced with actual values.
		rendered, err := engine.RenderString(tmpl.Messages.Success, vars)
		if err != nil {
			// Fallback to raw message if rendering fails.
			rendered = tmpl.Messages.Success
		}
		fmt.Println(StyleSuccess.Render(rendered))
	}

	return nil
}

// --- template create ---

var templateCreateCmd = &cobra.Command{
	Use:   "create <name>",
	Short: "Create a new template scaffold",
	Args:  cobra.ExactArgs(1),
	RunE:  runTemplateCreate,
}

func runTemplateCreate(cmd *cobra.Command, args []string) error {
	name := args[0]
	store := getStore()

	description, _ := cmd.Flags().GetString("description")
	doc, _ := cmd.Flags().GetString("doc")

	if err := store.Templates.Create(name, description); err != nil {
		return fmt.Errorf("create template: %w", err)
	}

	// If --doc was provided, update the generated _template.yaml to set the doc field.
	if doc != "" {
		configPath := filepath.Join(store.Root, "templates", name, "_template.yaml")
		data, err := os.ReadFile(configPath)
		if err == nil {
			content := string(data)
			content = strings.Replace(content, `doc: ""`, fmt.Sprintf("doc: %q", doc), 1)
			_ = os.WriteFile(configPath, []byte(content), 0644)
		}
	}

	fmt.Println(RenderSuccess(fmt.Sprintf("Created template: %s", name)))
	if doc != "" {
		fmt.Println(RenderKeyValue("Linked doc", doc))
	}
	fmt.Printf("%s .knowns/templates/%s/\n", StyleDim.Render("Edit the template at:"), name)
	return nil
}

// ---- output helpers ----

func printTemplatePlain(t *models.Template) {
	fmt.Printf("NAME: %s\n", t.Name)
	if t.Description != "" {
		fmt.Printf("DESCRIPTION: %s\n", t.Description)
	}
	if t.Version != "" {
		fmt.Printf("VERSION: %s\n", t.Version)
	}
	if t.Author != "" {
		fmt.Printf("AUTHOR: %s\n", t.Author)
	}
	if t.IsImported {
		fmt.Printf("IMPORTED FROM: %s\n", t.ImportName)
	}
	if t.Doc != "" {
		fmt.Printf("DOC: %s\n", t.Doc)
	}
	if t.Destination != "" {
		fmt.Printf("DESTINATION: %s\n", t.Destination)
	}
	if t.Path != "" {
		fmt.Printf("PATH: %s\n", t.Path)
	}
	if len(t.Prompts) > 0 {
		fmt.Println("PROMPTS:")
		for _, p := range t.Prompts {
			fmt.Printf("  - %s (%s)", p.Name, p.Type)
			if p.Message != "" {
				fmt.Printf(": %s", p.Message)
			}
			if p.Validate == "required" {
				fmt.Print(" [required]")
			}
			if p.Initial != "" {
				fmt.Printf(" (default: %s)", p.Initial)
			}
			fmt.Println()
		}
	}
	if len(t.Actions) > 0 {
		fmt.Println("ACTIONS:")
		for i, a := range t.Actions {
			fmt.Printf("  %d. %s", i+1, a.Type)
			if a.Path != "" {
				fmt.Printf(" → %s", a.Path)
			}
			if a.Template != "" {
				fmt.Printf(" (template: %s)", a.Template)
			}
			fmt.Println()
		}
	}
}

func printTemplateDetailed(t *models.Template) {
	fmt.Println(StyleTitle.Render(t.Name))
	if t.Description != "" {
		fmt.Println(StyleDim.Render(t.Description))
	}
	if t.Version != "" {
		fmt.Println(RenderKeyValue("Version", t.Version))
	}
	if t.Author != "" {
		fmt.Println(RenderKeyValue("Author", t.Author))
	}
	if t.IsImported {
		fmt.Println(RenderKeyValue("Imported from", t.ImportName))
	}
	if t.Doc != "" {
		fmt.Println(RenderKeyValue("Doc", t.Doc))
	}
	if t.Destination != "" {
		fmt.Println(RenderKeyValue("Destination", t.Destination))
	}
	if t.Path != "" {
		fmt.Println(RenderKeyValue("Path", t.Path))
	}
	if len(t.Prompts) > 0 {
		fmt.Printf("\n%s\n", RenderSectionHeader("Prompts"))
		for _, p := range t.Prompts {
			fmt.Printf("  %s %s %s", StyleDim.Render("-"), StyleBold.Render(p.Name), StyleDim.Render("("+p.Type+")"))
			if p.Message != "" {
				fmt.Printf(": %s", p.Message)
			}
			if p.Validate == "required" {
				fmt.Printf(" %s", StyleWarning.Render("[required]"))
			}
			if p.Initial != "" {
				fmt.Printf(" %s", StyleDim.Render("(default: "+p.Initial+")"))
			}
			fmt.Println()
		}
	}
	if len(t.Actions) > 0 {
		fmt.Printf("\n%s\n", RenderSectionHeader(fmt.Sprintf("Actions (%d)", len(t.Actions))))
		for i, a := range t.Actions {
			fmt.Printf("  %s %s", StyleDim.Render(fmt.Sprintf("%d.", i+1)), StyleInfo.Render("["+a.Type+"]"))
			if a.Path != "" {
				fmt.Printf(" %s", a.Path)
			}
			if a.Template != "" {
				fmt.Printf(" %s", StyleDim.Render("(template: "+a.Template+")"))
			}
			if a.SkipIfExists {
				fmt.Printf(" %s", StyleWarning.Render("[skip-if-exists]"))
			}
			fmt.Println()
		}
	}
	if t.Messages != nil {
		if t.Messages.Success != "" {
			fmt.Printf("\n%s %s\n", StyleDim.Render("Success message:"), t.Messages.Success)
		}
	}
}

// ---- init ----

func init() {
	// template list flags
	templateListCmd.Flags().Bool("local", false, "Show only local templates")
	templateListCmd.Flags().Bool("imported", false, "Show only imported templates")

	// template run flags
	templateRunCmd.Flags().Bool("dry-run", false, "Preview without writing files")
	templateRunCmd.Flags().StringArrayP("var", "v", nil, "Template variable (key=value, repeatable)")

	// template create flags
	templateCreateCmd.Flags().StringP("description", "d", "", "Template description")
	templateCreateCmd.Flags().String("doc", "", "Link to documentation (e.g., 'patterns/controller')")

	// Wire up subcommands
	templateCmd.AddCommand(templateListCmd)
	templateCmd.AddCommand(templateViewCmd)
	templateCmd.AddCommand(templateRunCmd)
	templateCmd.AddCommand(templateCreateCmd)

	// Register under root
	rootCmd.AddCommand(templateCmd)
}
