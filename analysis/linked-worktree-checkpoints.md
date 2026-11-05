# Linked worktree checkpoints — 0.21

The workspace and automatic turn coordinator now accept ordinary repositories
and Git's reciprocal linked-worktree layout. They validate the regular `.git`
pointer, canonical administrative/common directories, `commondir`, and the
backlink to this exact project. Submodules, arbitrary separate-git-dir layouts,
symlinked storage, split/sparse indexes and unsupported file modes remain
refused.

Each linked worktree uses its own administrative `index` and `index.lock`, plus
`refs/vek/checkpoints/worktree-<SHA-256(admin-path)[0:32]>/<UUID>` in common Git
storage. The ordinary repository keeps its original namespace and filters out
nested linked namespaces. A checkpoint ID from another worktree cannot be read
or restored through this project's API. Shared Git object storage remains under
Git's normal atomic object/ref handling.

Restore keeps the existing explicit preview/fingerprint/confirmation and
protection snapshot transaction. It reproduces staged, unstaged and untracked
bytes while preserving the other worktree's files, index, branch and stash.
Automatic turn associations additionally bind the administrative/common/pointer
filesystem identities; replacing `.git` invalidates their authority.

Six new tests use real temporary Git repositories: rich restore without main
index changes, three-way namespace isolation, independent locks, malicious
metadata/backlinks, GC/detached HEAD, and turn association identity replacement.
Together with the existing checkpoint/turn/translation tests, 31/31 passed;
full local regression passed 522/522. See
[focused evidence](../reports/v021-checkpoint-translation-tests.log).

Worktree move/repair changes the namespace or identity, so old associations do
not silently acquire restore authority at a new path. Nested repos, non-UTF-8
filenames, submodules and concurrent shared ref mutations retain their existing
bounded behavior; this is not a general repository backup tool.
