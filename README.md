[![REUSE status](https://api.reuse.software/badge/github.com/openmcp-project/build)](https://api.reuse.software/info/github.com/openmcp-project/build)

# Open Managed Control Planes Build and CI Scripts

## About this project

OpenMCP build and CI scripts

The Kubernetes operators in the openmcp-project use mostly the same `make` targets and surrounding scripts. This makes sense, because this way developers do not have to think about in which repo they are working right now - `make tidy` will always tidy the go modules.
The drawback is that all `make` targets and scripts have to be kept in sync. If the `make` targets have the same name but a different behavior (conceptually, not code-wise), this will became more of an disadvantage than an advantage. This 'keeping it in sync' means that adding an improvement to any of the scripts required this improvement to be added to all of the script's copies in the different repositories, which is annoying and error-prone.

To improve this, the scripts that are shared between the different repositories have been moved into this repository, which is intended to be used as a git submodule in the actual operator repositories.

Instead of `make`, we have decided to use the [task](https://taskfile.dev/) tool.

## Requirements

It is strongly recommended to include this submodule under the `hack/common` path in the operator repositories. While most of the coding is designed to work from anywhere within the including repository, there are some workarounds for bugs in `task` which rely on the assumption that this repo is a submodule under `hack/common` in the including repository.

## General Setup

To use this repository, first check it out via
```shell
git submodule add https://github.com/openmcp-project/build.git hack/common
```
and ensure that it is checked-out via
```shell
git submodule init
```

## Variants

These shared build tools can be used for repositories containing k8s controllers, as well as for ones that contain CLI tools. There are differences between both use-cases, a k8s controller needs an container image and might have a helm chart, while neither is the case for a CLI tool, which might want to attach its binaries to the github release instead, for example. The following sections describe the specifics for both variants.

### Controller/Library Variant

#### Taskfile

To use the generic Taskfile contained in this repository, create a `Taskfile.yaml` in the including repository. It should look something like this:
```yaml
version: 3

vars:
  NESTED_MODULES: api
  API_DIRS: '{{.ROOT_DIR}}/api/core/v1alpha1/...'
  MANIFEST_OUT: '{{.ROOT_DIR}}/api/crds/manifests'
  CODE_DIRS: '{{.ROOT_DIR}}/cmd/... {{.ROOT_DIR}}/internal/... {{.ROOT_DIR}}/test/... {{.ROOT_DIR}}/api/constants/... {{.ROOT_DIR}}/api/errors/... {{.ROOT_DIR}}/api/install/... {{.ROOT_DIR}}/api/v1alpha1/... {{.ROOT_DIR}}/api/core/v1alpha1/...'
  COMPONENTS: 'mcp-operator'
  REPO_NAME: 'https://github.com/openmcp-project/mcp-operator'
  GENERATE_DOCS_INDEX: "true"

includes:
  shared:
    taskfile: hack/common/Taskfile_controller.yaml
    flatten: true
```

⚠️⚠️⚠️ There is currently a [bug](https://github.com/go-task/task/issues/2108) in the `task` tool which causes it to not propagate variables from the top-level `vars` field to the included Taskfiles properly. As a workaround, the variables have to be specified in `includes.*.vars` instead.

> `ROOT_DIR` is a task-internal variable that points to the directory of the root Taskfile.

Since the imported Taskfile is generic, there are a few variables that need to be set in order to configure the tasks correctly. Unless specified otherwise, the variables must not be specified if their respective purpose doesn't apply to the importing repository (e.g. `NESTED_MODULES` is not required if there are no nested modules).
- `NESTED_MODULES`
  - List of nested modules, separated by spaces.
  - Note that the module has to be located in a subfolder that matches its name.
  - Required for multiple tools from the golang environment which are able to work on a single module only and therefore have to be called once per go module.
- `API_DIRS`
  - List of files with API type definitions for which k8s CRDs should be generated.
  - The `<directory>/...` syntax can be used to refer to all files in the directory and its subdirectories.
  - This is fed into the k8s code generation tool for CRD generation.
- `MANIFEST_OUT`
  - Directory where the generated CRDs should be put in.
- `CODE_DIRS`
  - List of files with go code, separated by spaces.
  - The `<directory>/...` syntax can be used to refer to all files in the directory and its subdirectories.
  - Formatting and linting checks are executed on these files.
  - This variable must always be specified.
- `COMPONENTS`
  - A list of 'components' contained in this repository, separated by spaces.
  - This is relevant for binary, image, chart, and OCM component building. Each entry will result in a separate build artifact for the respective builds.
  - A 'component' specified here has some implications:
    - A `cmd/<component>/main.go` file is expected for binary builds.
    - A separate docker image will be built for each component.
    - If the component has a helm chart, it is expected under `charts/<component>/`.
      - Note that support for helm charts is not fully implemented yet.
    - Each component will get its own OCM component.
      - Note that support for OCM components is not implemented yet.
  - Library repos will not have any component, operator repos will mostly contain just a single component (the operator itself).
- `REPO_URL`
  - URL of the github repository that contains the Taskfile.
  - This is used for building the OCM component, which will fail if it is not specified.
- `GENERATE_DOCS_INDEX`
  - If this is set and its value is not `false`, the `generate:docs` target will generate a documentation index at `docs/README.md`. Otherwise, the task is skipped.
  - See below for a short documentation of the the index generation.
- `ENVTEST_REQUIRED`
  - If this is set to `true`, the `test` task will include the `setup-envtest` tooling in its dependencies and download it automatically.

There are two main Taskfiles, one of which should be included:
- `Taskfile_controller.yaml` is meant for operator repositories and contains task definitions for code generation and validation, binary builds, and image builds.
- `Taskfile_library.yaml` is meant for library repos and does not include the tasks for binary and image building.

A minimal Taskfile for a library repository could look like this:
```yaml
version: 3

vars:
  CODE_DIRS: '{{.ROOT_DIR}}/pkg/...'

includes:
  shared:
    taskfile: hack/common/Taskfile_library.yaml
    flatten: true
```

#### Requirements

The controller variant of the Taskfile is able to handle multiple 'components' (= controller binaries) within the same repositories, but it expects a certain format for filepaths:
- Each component must have its `main.go` file at `cmd/<component>/main.go`.
- If the component has a helm chart, it must be under `charts/<component>`.

### CLI Variant

#### Taskfile

CLI repos must use the `Taskfile_cli.yaml` instead:
```yaml
version: 3

includes:
  shared:
    taskfile: hack/common/Taskfile_cli.yaml
    flatten: true
    vars:
      CODE_DIRS: '{{.ROOT_DIR}}/cmd/... {{.ROOT_DIR}}/internal/... {{.ROOT_DIR}}/lib/...'
      NESTED_MODULES: 'lib'
      NAME: 'ocp'
      REPO_NAME: 'https://github.com/openmcp-project/ocp'
      GENERATE_DOCS_INDEX: "true"
```

Most variables in the Taskfile behave exactly like for the controller variant, especially `CODE_DIRS`, `NESTED_MODULES`, and `REPO_NAME`. As a new variable, `NAME` has to be set to the name the CLI should be published under (`ocp` in the above example).

#### Requirements

The CLI taskfile currently supports only one binary per repository and its `main.go` file has to be at top-level within the repository (this also enables the tool to be installed via `go install`, as long as it does not contain any `replace` directives within its `go.mod` file).

## Further Taskfile Information

### Overwriting and Excluding Task Definitions

Adding new specialized tasks in addition to the imported generic ones is straightforward: simply add the task definitions in the importing Taskfile.

It is also possible to exclude or overwrite generic tasks. The following example uses an `external-apis` task that should be executed as part of the generic `generate:code` task.

Overwriting basically works by excluding and re-defining the generic task that should be overwritten. If the generic task's logic should be kept as part of the overwritten definition, the generic file needs to be imported a second time with `internal: true`, so that the original task can be called.

Note that some tasks are re-used internally with a different name due to the way `task` handles scoping. If you overwrite a task and run into issues, you might have to overwrite the same task again with a different name. In theory, adding a fitting alias to the overwrite should suffice. This theory has not yet been tested, though.

```yaml
includes:
  shared:
    taskfile: hack/common/Taskfile_controller.yaml
    flatten: true
    excludes: # put task names in here which are overwritten in this file
    - generate:code
  common: # imported a second time so that overwriting task definitions can call the overwritten task with a 'c:' prefix
    taskfile: hack/common/Taskfile_controller.yaml
    internal: true
    aliases:
    - c

tasks:
  generate:code: # overwrites shared code task to add external API fetching
    desc: "  Generate code (mainly DeepCopy functions) and fetches external APIs."
    aliases:
    - gen:code
    - g:code
    run: once
    cmds:
    - task: external-apis
    - task: c:generate:code

  external-apis:
    desc: "  Fetch external APIs."
    run: once
    <...>
    internal: true
```

### Makefile

This repo contains a dummy Makefile that for any command prints the instructions for installing `task`:
```
This repository uses task (https://taskfile.dev) instead of make.
Run 'go install github.com/go-task/task/v3/cmd/task@latest' to install the latest version.
Then run 'task -l' to list available tasks.
```

To re-use it, simply create a symbolic link from the importing repo:
```shell
ln -s ./hack/common/Makefile Makefile
```

## GitHub Actions Workflows

This repository provides reusable GitHub Actions workflows that can be called from downstream repositories.

### Available Workflows

| Workflow | Purpose |
|---|---|
| `ci.lib.yaml` | Runs code generation, validation, and tests |
| `publish.lib.yaml` | Builds and publishes images, charts, and OCM components |
| `release.lib.yaml` | Creates releases and tags |
| `renovate-generate.lib.yaml` | Runs `task generate` on Renovate branches and commits the result |
| `homebrew.lib.yaml` | Makes the binary available via a custom homebrew tap (CLI variant only) |

### Renovate: Auto-generate after dependency updates

When Renovate updates a dependency (e.g. Go module, tool version), files like CRD manifests or generated code may need to be regenerated. The `renovate-generate.lib.yaml` workflow handles this automatically: it triggers on pushes to `renovate/**` branches, runs `task generate`, and commits any changed files back to the branch.

To use it, add the following workflow to the downstream repository:

```yaml
# .github/workflows/renovate-generate.yaml
name: Renovate Generate

on:
  push:
    branches:
      - "renovate/**"

permissions:
  contents: write

jobs:
  generate:
    uses: openmcp-project/build/.github/workflows/renovate-generate.lib.yaml@main
    secrets: inherit
```

Also add the following to the repository's `renovate.json`. This tells Renovate to ignore commits from `github-actions[bot]` when determining whether a branch has been modified externally, which is necessary to keep `:rebaseStalePrs` working correctly:

```json
"gitIgnoredAuthors": [
  "github-actions[bot]@users.noreply.github.com"
]
```

### Homebrew Workflow

The widely known package manager `homebrew` supports custom package repositories (called 'taps'), which are basically just github repositories that follow a specific structure. Usually, they contain a `Formula` folder which contains scripts for each package ('formula') that is available via the tap. This repository contains a github workflow which can be used to make a CLI tool available via a homebrew tap.

The homebrew tap repo's name must be prefixed with `homebrew-`.

The workflow can then be reused like this:
```yaml
name: Homebrew Releaser

on:
  release:
    types:
    - published

jobs:
  homebrew:
    uses: openmcp-project/build/.github/workflows/homebrew.lib.yaml@main
    secrets: inherit
    with:
      username: <user/org name of homebrew tap repo owner>
      tap: <homebrew tap repo name> # must start with 'homebrew-'
      binary: <binary name> # optional
      readme_table: false # optional
```

The binary name argument is optional. It specifies under which name the tool will be available in the homebrew tap. It has to match the name of the binary contained in the tarball attached to the release which triggered the workflow. This corresponds to the `NAME` variable that has to be specified in the CLI variant taskfile. If not specified, the workflow assumes this to be identical to the repository name.

The github action that is used to manage the homebrew tap is also able to render a table listing all formulae of the tap into the tap repo's README. This requires a placeholder like this within the README:
```markdown
<!-- project_table_start -->
TABLE HERE
<!-- project_table_end -->
```
> [!NOTE]
> For some reason, the action computes the table _before_ adding the calling repo's formula and it fails if there are no formulae within the tap, which means
>   - table generation must be disabled for the first run, if the homebrew tap repo does not have any formulae yet
>   - when a new formula is added, it will only appear in the table when the workflow is run again _after_ the run that added the new formula

## Documentation Generation

### Documentation Index

This repository contains a script for creating a index for the documentation of the importing repository. This script is not executed by default, only if the `GENERATE_DOCS_INDEX` variable is explicitly set to anything except `false` in the importing Taskfile. Doing so will not only activate the documentation index generation, but also a check whether it is up-to-date during the `validate:docs` task.

⚠️ Running the documentation index generation script will overwrite the `docs/README.md` file!

The script checks the `docs` folder in the importing repository for subdirectories and markdown files (*.md) contained within. Each directory that contains a special metadata file will result in a header, followed by a list where each entry links to one of the markdown files of the respective directory. Directories without the metadata file will be ignored.

The metadata file is named `.docnames` and is expected to be JSON-formatted, containing a single object with a field named `header`. The value of this field will determine the name of the header in the documentation index for this respective folder.

Additional fields in the JSON object can be used to manipulate the entries for markdown files within the directory: An entry `"foo.md": "Bar"` in the object causes the `foo.md` file in the directory to be displayed as `Bar` in the generated index. Setting the value of such an entry to the empty string removes the corresponding file from the index.

Markdown files whose name is not overwritten by a corresponding field in the metadata file are named according to the first line starting with `# ` (or `## `) in their content, or ignored if the name cannot be determined this way.

### Command Reference Generation (CLI only)

The [cobra](https://github.com/spf13/cobra) framework, which is commonly used for CLI tool implementation, comes with the possibility to generate a markdown command reference. This can be automatically executend by the `generate:command-reference` task, which is part of the `generate` task. The reference generation requires a file like this
```go
package main

import (
	"os"

	"github.com/spf13/cobra/doc"

	"<my-cli-module>/cmd"
)

func main() {
	if len(os.Args) < 2 {
		panic("documentation folder path required as argument")
	}
	if err := doc.GenMarkdownTree(cmd.NewMyCommand(), os.Args[1]); err != nil {
		panic(err)
	}
}
```
where `cmd.NewMyCommand()` returns the root `cobra.Command`.

By default, this file is expected under `hack/cmdref/main.go`, but this location can be customized by setting the `REFERENCE_GENERATOR` variable in the taskfile.

The command reference will be generated into `docs/reference`. While the reference generation creates the folder, if it doesn't exist, note that the `.docnames` file has to be added to it manually, if the command reference should appear in the documentation index (see above). This only needs to be done once.

> [!IMPORTANT]
> By default, the cobra reference generation adds a timestamp to each generated markdown file, which causes all of them to change every time the code generation is run, which causes a lot of irrelevant git changes. This behavior can be disabled by setting the `DisableAutoGenTag` to `true` in the `cobra.Command` that is is passed into `doc.GenMarkdownTree`.

> [!NOTE]
> While initially implemented for the `cobra` reference generation, `task generate:command-reference` actually just calls the go main file at the `REFERENCE_GENERATOR` path. This leaves the option to use some other tool or custom logic to generate the command reference. The generator gets one argument, which is the path to the folder where the command reference should be generated into.

#### Limitations

The script is rather primitive and can only handle a single hierarchy level, nested folder structures are not supported. Manipulating or configuring the generated index apart from adapting the names is also not possible.

## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/openmcp-project/build/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Security / Disclosure
If you find any bug that may be a security problem, please follow our instructions at [in our security policy](https://github.com/openmcp-project/build/security/policy) on how to report it. Please do not create GitHub issues for security-related doubts or problems.

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](https://github.com/openmcp-project/.github/blob/main/CODE_OF_CONDUCT.md) at all times.

## Licensing

Copyright OpenControlPlane contributors. Please see our [LICENSE](LICENSE) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/openmcp-project/build).

---

<p align="center">
  <a href="https://apeirora.eu/content/projects/">
    <img alt="BMWK-EU funding logo" src="https://apeirora.eu/assets/img/BMWK-EU.png" width="300"/>
  </a>
</p>

<p align="center">
  OpenControlPlane is part of <a href="https://apeirora.eu/content/projects/">ApeiroRA</a>, an EU Important Project of Common European Interest (IPCEI-CIS).
</p>

<p align="center">
  Copyright Linux Foundation Europe. For web site terms of use, trademark policy and other project policies please see <a href="https://linuxfoundation.eu/en/policies">https://linuxfoundation.eu/en/policies</a>.
</p>
