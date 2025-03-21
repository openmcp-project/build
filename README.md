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

## Setup

To use this repository, first check it out via
```shell
git submodule add https://github.com/openmcp-project/build.git hack/common
```
and ensure that it is checked-out via
```shell
git submodule init
```

### Taskfile

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

#### Overwriting and Excluding Task Definitions

Adding new specialized tasks in addition to the imported generic ones is straightforward: simply add the task definitions in the importing Taskfile.

It is also possible to exclude or overwrite generic tasks. The following example uses an `external-apis` task that should be executed as part of the generic `generate:code` task, and it adds a envtest dependency to the `validate:test` task.

Overwriting basically works by excluding and re-defining the generic task that should be overwritten. If the generic task's logic should be kept as part of the overwritten definition, the generic file needs to be imported a second time with `internal: true`, so that the original task can be called.

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

  validate:test: # overwrites the test task to add a dependency towards envtest
    desc: "  Run all tests."
    aliases:
    - val:test
    - v:test
    run: once
    deps:
    - tools:envtest
    cmds:
    - task: c:validate:test
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

## Documentation Index Generation

This repository contains a script for creating a index for the documentation of the importing repository. This script is not executed by default, only if the `GENERATE_DOCS_INDEX` variable is explicitly set to anything except `false` in the importing Taskfile. Doing so will not only activate the documentation index generation, but also a check whether it is up-to-date during the `validate:docs` task.

⚠️ Running the documentation index generation script will overwrite the `docs/README.md` file!

The script checks the `docs` folder in the importing repository for subdirectories and markdown files (*.md) contained within. Each directory that contains a special metadata file will result in a header, followed by a list where each entry links to one of the markdown files of the respective directory. Directories without the metadata file will be ignored.

The metadata file is named `.docnames` and is expected to be JSON-formatted, containing a single object with a field named `header`. The value of this field will determine the name of the header in the documentation index for this respective folder.

Additional fields in the JSON object can be used to manipulate the entries for markdown files within the directory: An entry `"foo.md": "Bar"` in the object causes the `foo.md` file in the directory to be displayed as `Bar` in the generated index. Setting the value of such an entry to the empty string removes the corresponding file from the index.

Markdown files whose name is not overwritten by a corresponding field in the metadata file are named according to the first line starting with `# ` in their content, or ignored if the name cannot be determined this way.

#### Limitations

The script is rather primitive and can only handle a single hierarchy level, nested folder structures are not supported. Manipulating or configuring the generated index apart from adapting the names is also not possible.

## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc. via [GitHub issues](https://github.com/openmcp-project/build/issues). Contribution and feedback are encouraged and always welcome. For more information about how to contribute, the project structure, as well as additional contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Security / Disclosure
If you find any bug that may be a security problem, please follow our instructions at [in our security policy](https://github.com/openmcp-project/build/security/policy) on how to report it. Please do not create GitHub issues for security-related doubts or problems.

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for everyone. By participating in this project, you agree to abide by its [Code of Conduct](https://github.com/openmcp-project/.github/blob/main/CODE_OF_CONDUCT.md) at all times.

## Licensing

Copyright 2025 SAP SE or an SAP affiliate company and build contributors. Please see our [LICENSE](LICENSE) for copyright and license information. Detailed information including third-party components and their licensing/copyright information is available [via the REUSE tool](https://api.reuse.software/info/github.com/openmcp-project/build).
