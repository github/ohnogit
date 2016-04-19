import * as path from 'path'
import ResourcePool from './resource-pool'

const fs = require('fs-plus')
const {Emitter, CompositeDisposable, Disposable} = require('event-kit')
const Git = require('nodegit')
const _ = require('underscore-plus')

const modifiedStatusFlags: number = Git.Status.STATUS.WT_MODIFIED | Git.Status.STATUS.INDEX_MODIFIED | Git.Status.STATUS.WT_DELETED | Git.Status.STATUS.INDEX_DELETED | Git.Status.STATUS.WT_TYPECHANGE | Git.Status.STATUS.INDEX_TYPECHANGE
const newStatusFlags: number = Git.Status.STATUS.WT_NEW | Git.Status.STATUS.INDEX_NEW
const deletedStatusFlags: number = Git.Status.STATUS.WT_DELETED | Git.Status.STATUS.INDEX_DELETED
const indexStatusFlags: number = Git.Status.STATUS.INDEX_NEW | Git.Status.STATUS.INDEX_MODIFIED | Git.Status.STATUS.INDEX_DELETED | Git.Status.STATUS.INDEX_RENAMED | Git.Status.STATUS.INDEX_TYPECHANGE
const ignoredStatusFlags = 1 << 14 // TODO: compose this from libgit2 constants
const submoduleMode = 57344 // TODO: compose this from libgit2 constants

// A stand-in for the NodeGit repository type until we have a real one.
export type NodeGitRepository = any

export default class Repository {
  public path: string
  public openedPath: string
  private isCaseInsensitive: boolean
  public pathStatusCache: {[key: string]: number}
  public upstream: {ahead: number, behind: number}
  public submodules: {[key: string]: Repository}
  public branch: string
  private emitter: any

  private openExactPath: boolean

  private repoPromise: Promise<NodeGitRepository>
  private repoPool: ResourcePool<Promise<NodeGitRepository>>

  private _refreshingPromise: Promise<void>

  public static open (path: string, options: {openExactPath?: boolean} = {}) {
    // QUESTION: Should this wrap Git.Repository and reject with a nicer message?
    return new Repository(path, options)
  }

  public static get Git () {
    return Git
  }

  // The name of the error thrown when an action is attempted on a destroyed
  // repository.
  static get DestroyedErrorName () {
    return 'Repository.destroyed'
  }

  public constructor (_path: string, options: {openExactPath?: boolean} = {}) {
    // We'll serialize our access manually.
    Git.setThreadSafetyStatus(Git.THREAD_SAFETY.DISABLED)

    this.emitter = new Emitter()
    this.pathStatusCache = {}
    this.path = null

    // NB: These needs to happen before the following .openRepository call.
    this.openedPath = _path
    this.openExactPath = options.openExactPath || false

    this.repoPromise = this.openRepository()
    // NB: We don't currently _use_ the pooled object. But by giving it one
    // thing, we're really just serializing all the work. Down the road, we
    // could open multiple connections to the repository.
    this.repoPool = new ResourcePool([this.repoPromise])

    this.isCaseInsensitive = fs.isCaseInsensitive()
    this.upstream = {ahead: 0, behind: 0}
    this.submodules = {}

    this._refreshingPromise = Promise.resolve()
  }

  // Public: Destroy this {Repository} object.
  //
  // This destroys any tasks and subscriptions and releases the underlying
  // libgit2 repository handle. This method is idempotent.
  public destroy () {
    if (this.emitter) {
      this.emitter.emit('did-destroy')
      this.emitter.dispose()
      this.emitter = null
    }

    this.repoPromise = null
  }

  // Event subscription
  // ==================

  // Public: Invoke the given callback when this Repository's destroy()
  // method is invoked.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  public onDidDestroy (callback: Function) {
    return this.emitter.on('did-destroy', callback)
  }

  // Public: Invoke the given callback when a specific file's status has
  // changed. When a file is updated, reloaded, etc, and the status changes,
  // this will be fired.
  //
  // * `callback` {Function}
  //   * `event` {Object}
  //     * `path` {String} the old parameters the decoration used to have
  //     * `pathStatus` {Number} representing the status. This value can be passed to
  //       {::isStatusModified} or {::isStatusNew} to get more information.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  public onDidChangeStatus (callback: ({path: string, pathStatus: number}) => void) {
    return this.emitter.on('did-change-status', callback)
  }

  // Public: Invoke the given callback when a multiple files' statuses have
  // changed. For example, on window focus, the status of all the paths in the
  // repo is checked. If any of them have changed, this will be fired. Call
  // {::getPathStatus(path)} to get the status for your path of choice.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  public onDidChangeStatuses (callback: Function) {
    return this.emitter.on('did-change-statuses', callback)
  }

  // Repository details
  // ==================

  // Public: Returns a {Promise} which resolves to the {String} path of the
  // repository.
  public getPath (): Promise<string> {
    return this.getRepo().then(repo => {
      if (!this.path) {
        this.path = repo.path().replace(/\/$/, '')
      }

      return this.path
    })
  }

  // Public: Returns a {Promise} which resolves to the {String} working
  // directory path of the repository.
  public getWorkingDirectory (_path?: string | null): Promise<string> {
    return this.getRepo(_path).then(repo => {
      if (!repo.cachedWorkdir) {
        repo.cachedWorkdir = repo.workdir()
      }

      return repo.cachedWorkdir
    })
  }

  // Public: Makes a path relative to the repository's working directory.
  //
  // * `path` The {String} path to relativize.
  //
  // Returns a {Promise} which resolves to the relative {String} path.
  public relativizeToWorkingDirectory (_path: string): Promise<string> {
    return this.getWorkingDirectory()
      .then(wd => this.relativize(_path, wd))
  }

  // Public: Makes a path relative to the repository's working directory.
  //
  // * `path` The {String} path to relativize.
  // * `workingDirectory` The {String} working directory path.
  //
  // Returns the relative {String} path.
  public relativize (_path: string, workingDirectory: string): string {
    // The original implementation also handled null workingDirectory as it
    // pulled it from a sync function that could return null. We require it
    // to be passed here.
    let openedWorkingDirectory: string | null
    if (!_path || !workingDirectory) {
      return _path
    }

    // If the opened directory and the workdir differ, this is a symlinked repo
    // root, so we have to do all the checks below twice--once against the realpath
    // and one against the opened path
    const opened = this.openedPath.replace(/\/\.git$/, '')
    if (path.relative(opened, workingDirectory) !== '') {
      openedWorkingDirectory = opened
    }

    if (process.platform === 'win32') {
      _path = _path.replace(/\\/g, '/')
    } else {
      if (_path[0] !== '/') {
        return _path
      }
    }

    workingDirectory = workingDirectory.replace(/\/$/, '')

    // Depending on where the paths come from, they may have a '/private/'
    // prefix. Standardize by stripping that out.
    _path = _path.replace(/^\/private\//i, '/')
    workingDirectory = workingDirectory.replace(/^\/private\//i, '/')

    const originalPath = _path
    const originalWorkingDirectory = workingDirectory
    if (this.isCaseInsensitive) {
      _path = _path.toLowerCase()
      workingDirectory = workingDirectory.toLowerCase()
    }

    if (_path.indexOf(workingDirectory) === 0) {
      return originalPath.substring(originalWorkingDirectory.length + 1)
    } else if (_path === workingDirectory) {
      return ''
    }

    if (openedWorkingDirectory) {
      openedWorkingDirectory = openedWorkingDirectory.replace(/\/$/, '')
      openedWorkingDirectory = openedWorkingDirectory.replace(/^\/private\//i, '/')

      const originalOpenedWorkingDirectory = openedWorkingDirectory
      if (this.isCaseInsensitive) {
        openedWorkingDirectory = openedWorkingDirectory.toLowerCase()
      }

      if (_path.indexOf(openedWorkingDirectory) === 0) {
        return originalPath.substring(originalOpenedWorkingDirectory.length + 1)
      } else if (_path === openedWorkingDirectory) {
        return ''
      }
    }

    return _path
  }

  // Public: Returns a {Promise} which resolves to whether the given branch
  // exists.
  public hasBranch (branch: string): Promise<boolean> {
    return this.repoPool.enqueue(() => {
      return this.getRepo()
        .then(repo => repo.getBranch(branch))
        .then(branch => branch != null)
        .catch(_ => false)
    })
  }

  // Public: Retrieves a shortened version of the HEAD reference value.
  //
  // This removes the leading segments of `refs/heads`, `refs/tags`, or
  // `refs/remotes`.  It also shortens the SHA-1 of a detached `HEAD` to 7
  // characters.
  //
  // * `path` An optional {String} path in the repository to get this information
  //   for, only needed if the repository contains submodules.
  //
  // Returns a {Promise} which resolves to a {String}.
  public getShortHead (_path?: string | null): Promise<string> {
    return this.repoPool.enqueue(() => {
      return this.getRepo(_path)
        .then(repo => repo.getCurrentBranch())
        .then(branch => branch.shorthand())
    })
  }

  // Public: Is the given path a submodule in the repository?
  //
  // * `path` The {String} path to check.
  //
  // Returns a {Promise} that resolves true if the given path is a submodule in
  // the repository.
  public isSubmodule (_path: string): Promise<boolean> {
    return this.relativizeToWorkingDirectory(_path)
      .then(relativePath => {
        return this.repoPool.enqueue(() => {
          return this.getRepo()
            .then(repo => repo.index())
            .then(index => {
              const entry = index.getByPath(relativePath)
              if (!entry) { return false }

              return entry.mode === submoduleMode
            })
        })
      })
  }

  // Public: Returns the number of commits behind the current branch is from the
  // its upstream remote branch.
  //
  // * `reference` The {String} branch reference name.
  // * `path`      The {String} path in the repository to get this information
  //               for, only needed if the repository contains submodules.
  //
  // Returns a {Promise} which resolves to an {Object} with the following keys:
  //   * `ahead`  The {Number} of commits ahead.
  //   * `behind` The {Number} of commits behind.
  public getAheadBehindCount (reference: string, _path?: string | null): Promise<{ahead: number, behind: number}> {
    return this.repoPool.enqueue(() => {
      return this.getRepo(_path)
        .then(repo => Promise.all([repo, repo.getBranch(reference)]))
        .then(([repo, local]) => {
          const upstream = Git.Branch.upstream(local)
          return Promise.all([repo, local, upstream])
        })
        .then(([repo, local, upstream]) => {
          return Git.Graph.aheadBehind(repo, local.target(), upstream.target())
        })
        .catch(_ => ({ahead: 0, behind: 0}))
    })
  }

  // Public: Get the cached ahead/behind commit counts for the current branch's
  // upstream branch.
  //
  // * `path` An optional {String} path in the repository to get this information
  //   for, only needed if the repository has submodules.
  //
  // Returns a {Promise} which resolves to an {Object} with the following keys:
  //   * `ahead`  The {Number} of commits ahead.
  //   * `behind` The {Number} of commits behind.
  public getCachedUpstreamAheadBehindCount (_path?: string | null): Promise<{ahead: number, behind: number}> {
    return this.relativizeToWorkingDirectory(_path)
      .then(relativePath => this._submoduleForPath(_path))
      .then(submodule => {
        if (submodule) {
          return submodule.getCachedUpstreamAheadBehindCount(_path)
        } else {
          return this.upstream
        }
      })
  }

  // Public: Returns the git configuration value specified by the key.
  //
  // * `path` An optional {String} path in the repository to get this information
  //   for, only needed if the repository has submodules.
  //
  // Returns a {Promise} which resolves to the {String} git configuration value
  // specified by the key.
  public getConfigValue (key: string, _path?: string | null): Promise<string | null> {
    return this.repoPool.enqueue(() => {
      return this.getRepo(_path)
        .then(repo => repo.configSnapshot())
        .then(config => config.getStringBuf(key))
        .catch(_ => null)
    })
  }

  // Public: Get the URL for the 'origin' remote.
  //
  // * `path` (optional) {String} path in the repository to get this information
  //   for, only needed if the repository has submodules.
  //
  // Returns a {Promise} which resolves to the {String} origin url of the
  // repository.
  public getOriginURL (_path?: string | null): Promise<string | null> {
    return this.getConfigValue('remote.origin.url', _path)
  }

  // Public: Returns the upstream branch for the current HEAD, or null if there
  // is no upstream branch for the current HEAD.
  //
  // * `path` An optional {String} path in the repo to get this information for,
  //   only needed if the repository contains submodules.
  //
  // Returns a {Promise} which resolves to a {String} branch name such as
  // `refs/remotes/origin/master`.
  public getUpstreamBranch (_path?: string | null): Promise<string | null> {
    return this.repoPool.enqueue(() => {
      return this.getRepo(_path)
        .then(repo => repo.getCurrentBranch())
        .then(branch => Git.Branch.upstream(branch))
    })
  }

  // Public: Gets all the local and remote references.
  //
  // * `path` An optional {String} path in the repository to get this information
  //   for, only needed if the repository has submodules.
  //
  // Returns a {Promise} which resolves to an {Object} with the following keys:
  //  * `heads`   An {Array} of head reference names.
  //  * `remotes` An {Array} of remote reference names.
  //  * `tags`    An {Array} of tag reference names.
  public getReferences (_path?: string | null): Promise<{heads: string[], remotes: string[], tags: string[]}> {
    return this.repoPool.enqueue(() => {
      return this.getRepo(_path)
        .then(repo => repo.getReferences(Git.Reference.TYPE.LISTALL))
        .then(refs => {
          const heads: string[] = []
          const remotes: string[] = []
          const tags: string[] = []
          for (const ref of refs) {
            if (ref.isTag()) {
              tags.push(ref.name())
            } else if (ref.isRemote()) {
              remotes.push(ref.name())
            } else if (ref.isBranch()) {
              heads.push(ref.name())
            }
          }
          return {heads, remotes, tags}
        })
    })
  }

  // Public: Get the SHA for the given reference.
  //
  // * `reference` The {String} reference to get the target of.
  // * `path` An optional {String} path in the repo to get the reference target
  //   for. Only needed if the repository contains submodules.
  //
  // Returns a {Promise} which resolves to the current {String} SHA for the
  // given reference.
  public getReferenceTarget (reference: string, _path?: string | null): Promise<string | null> {
    return this.repoPool.enqueue(() => {
      return this.getRepo(_path)
        .then(repo => Git.Reference.nameToId(repo, reference))
        .then(oid => oid.tostrS())
    })
  }

  // Reading Status
  // ==============

  // Public: Resolves true if the given path is modified.
  //
  // * `path` The {String} path to check.
  //
  // Returns a {Promise} which resolves to a {Boolean} that's true if the `path`
  // is modified.
  public isPathModified (_path: string): Promise<boolean> {
    return this.relativizeToWorkingDirectory(_path)
      .then(relativePath => this._getStatus([relativePath]))
      .then(statuses => statuses.some(status => status.isModified()))
  }

  // Public: Resolves true if the given path is new.
  //
  // * `path` The {String} path to check.
  //
  // Returns a {Promise} which resolves to a {Boolean} that's true if the `path`
  // is new.
  public isPathNew (_path: string): Promise<boolean> {
    return this.relativizeToWorkingDirectory(_path)
      .then(relativePath => this._getStatus([relativePath]))
      .then(statuses => statuses.some(status => status.isNew()))
  }

  // Public: Is the given path ignored?
  //
  // * `path` The {String} path to check.
  //
  // Returns a {Promise} which resolves to a {Boolean} that's true if the `path`
  // is ignored.
  public isPathIgnored (_path: string): Promise<boolean> {
    return this.getWorkingDirectory()
      .then(wd => {
        return this.repoPool.enqueue(() => {
          return this.getRepo()
            .then(repo => {
              const relativePath = this.relativize(_path, wd)
              return Git.Ignore.pathIsIgnored(repo, relativePath)
            })
            .then(ignored => Boolean(ignored))
        })
      })
  }

  // Get the status of a directory in the repository's working directory.
  //
  // * `directoryPath` The {String} path to check.
  //
  // Returns a {Promise} resolving to a {Number} representing the status. This
  // value can be passed to {::isStatusModified} or {::isStatusNew} to get more
  // information.
  public getDirectoryStatus (directoryPath: string): Promise<number> {
    return this.relativizeToWorkingDirectory(directoryPath)
      .then(relativePath => {
        const pathspec = relativePath + '/**'
        return this._getStatus([pathspec])
      })
      .then(statuses => {
        return Promise.all(statuses.map(s => s.statusBit())).then(bits => {
          return bits
            .filter(b => b > 0)
            .reduce((status, bit) => status | bit, 0)
        })
      })
  }

  // Refresh the status bit for the given path.
  //
  // Note that if the status of the path has changed, this will emit a
  // 'did-change-status' event.
  //
  // * `path` The {String} path whose status should be refreshed.
  //
  // Returns a {Promise} which resolves to a {Number} which is the refreshed
  // status bit for the path.
  public refreshStatusForPath (_path: string): Promise<number> {
    let relativePath: string | null
    return this.getWorkingDirectory()
      .then(wd => {
        relativePath = this.relativize(_path, wd)
        return this._getStatus([relativePath])
      })
      .then(statuses => {
        const cachedStatus = this.pathStatusCache[relativePath] || 0
        const status = statuses[0] ? statuses[0].statusBit() : Git.Status.STATUS.CURRENT
        if (status !== cachedStatus) {
          if (status === Git.Status.STATUS.CURRENT) {
            delete this.pathStatusCache[relativePath]
          } else {
            this.pathStatusCache[relativePath] = status
          }

          this.emitter.emit('did-change-status', {path: _path, pathStatus: status})
        }

        return status
      })
  }

  // Returns a Promise that resolves to the status bit of a given path if it has
  // one, otherwise 'current'.
  public getPathStatus (_path: string): Promise<number> {
    return this.refreshStatusForPath(_path)
  }

  // Public: Get the cached status for the given path.
  //
  // * `path` A {String} path in the repository, relative or absolute.
  //
  // Returns a {Promise} which resolves to a status {Number} or null if the
  // path is not in the cache.
  public getCachedPathStatus (_path: string): Promise<number | null> {
    return this.relativizeToWorkingDirectory(_path)
      .then(relativePath => this.pathStatusCache[relativePath])
  }

  // Public: Get the cached statuses for the repository.
  //
  // Returns an {Object} of {Number} statuses, keyed by {String} working
  // directory-relative file names.
  public getCachedPathStatuses (): {[key: string]: number} {
    return this.pathStatusCache
  }

  // Public: Returns true if the given status indicates modification.
  //
  // * `statusBit` A {Number} representing the status.
  //
  // Returns a {Boolean} that's true if the `statusBit` indicates modification.
  public isStatusModified (statusBit: number): boolean {
    return (statusBit & modifiedStatusFlags) > 0
  }

  // Public: Returns true if the given status indicates a new path.
  //
  // * `statusBit` A {Number} representing the status.
  //
  // Returns a {Boolean} that's true if the `statusBit` indicates a new path.
  public isStatusNew (statusBit: number): boolean {
    return (statusBit & newStatusFlags) > 0
  }

  // Public: Returns true if the given status indicates the path is staged.
  //
  // * `statusBit` A {Number} representing the status.
  //
  // Returns a {Boolean} that's true if the `statusBit` indicates the path is
  // staged.
  public isStatusStaged (statusBit: number): boolean {
    return (statusBit & indexStatusFlags) > 0
  }

  // Public: Returns true if the given status indicates the path is ignored.
  //
  // * `statusBit` A {Number} representing the status.
  //
  // Returns a {Boolean} that's true if the `statusBit` indicates the path is
  // ignored.
  public isStatusIgnored (statusBit: number): boolean {
    return (statusBit & ignoredStatusFlags) > 0
  }

  // Public: Returns true if the given status indicates the path is deleted.
  //
  // * `statusBit` A {Number} representing the status.
  //
  // Returns a {Boolean} that's true if the `statusBit` indicates the path is
  // deleted.
  public isStatusDeleted (statusBit: number): boolean {
    return (statusBit & deletedStatusFlags) > 0
  }

  // Retrieving Diffs
  // ================
  // Public: Retrieves the number of lines added and removed to a path.
  //
  // This compares the working directory contents of the path to the `HEAD`
  // version.
  //
  // * `path` The {String} path to check.
  //
  // Returns a {Promise} which resolves to an {Object} with the following keys:
  //   * `added` The {Number} of added lines.
  //   * `deleted` The {Number} of deleted lines.
  public getDiffStats (_path: string): Promise<{added: number, deleted: number}> {
    return this.getWorkingDirectory(_path)
      .then(wd => {
        return this.repoPool.enqueue(() => {
          return this.getRepo(_path)
            .then(repo => Promise.all([repo, repo.getHeadCommit()]))
            .then(([repo, headCommit]) => Promise.all([repo, headCommit.getTree()]))
            .then(([repo, tree]) => {
              const options = new Git.DiffOptions()
              options.contextLines = 0
              options.flags = Git.Diff.OPTION.DISABLE_PATHSPEC_MATCH
              options.pathspec = this.relativize(_path, wd)
              if (process.platform === 'win32') {
                // Ignore eol of line differences on windows so that files checked in
                // as LF don't report every line modified when the text contains CRLF
                // endings.
                options.flags |= Git.Diff.OPTION.IGNORE_WHITESPACE_EOL
              }
              return Git.Diff.treeToWorkdir(repo, tree, options)
            })
            .then(diff => this._getDiffLines(diff))
            .then(lines => {
              const stats = {added: 0, deleted: 0}
              for (const line of lines) {
                const origin = line.origin()
                if (origin === Git.Diff.LINE.ADDITION) {
                  stats.added++
                } else if (origin === Git.Diff.LINE.DELETION) {
                  stats.deleted++
                }
              }
              return stats
            })
        })
      })
  }

  // Public: Retrieves the line diffs comparing the `HEAD` version of the given
  // path and the given text.
  //
  // * `path` The {String} path relative to the repository.
  // * `text` The {String} to compare against the `HEAD` contents
  //
  // Returns a {Promise} which resolves to an {Array} of hunk {Object}s with the
  // following keys:
  //   * `oldStart` The line {Number} of the old hunk.
  //   * `newStart` The line {Number} of the new hunk.
  //   * `oldLines` The {Number} of lines in the old hunk.
  //   * `newLines` The {Number} of lines in the new hunk
  public getLineDiffs (_path: string, text: string): Promise<{oldStart: number, newStart: number, oldLines: number, newLines: number}[]> {
    return this.getWorkingDirectory(_path)
      .then(wd => {
        let relativePath: string | null = null
        return this.repoPool.enqueue(() => {
          return this.getRepo(_path)
            .then(repo => {
              relativePath = this.relativize(_path, wd)
              return repo.getHeadCommit()
            })
            .then(commit => commit.getEntry(relativePath))
            .then(entry => entry.getBlob())
            .then(blob => {
              const options = new Git.DiffOptions()
              options.contextLines = 0
              if (process.platform === 'win32') {
                // Ignore eol of line differences on windows so that files checked in
                // as LF don't report every line modified when the text contains CRLF
                // endings.
                options.flags = Git.Diff.OPTION.IGNORE_WHITESPACE_EOL
              }
              return this._diffBlobToBuffer(blob, text, options)
            })
        })
      })
  }

  // Checking Out
  // ============

  // Public: Restore the contents of a path in the working directory and index
  // to the version at `HEAD`.
  //
  // This is essentially the same as running:
  //
  // ```sh
  //   git reset HEAD -- <path>
  //   git checkout HEAD -- <path>
  // ```
  //
  // * `path` The {String} path to checkout.
  //
  // Returns a {Promise} that resolves or rejects depending on whether the
  // method was successful.
  public checkoutHead (_path: string): Promise<void> {
    return this.getWorkingDirectory(_path)
      .then(wd => {
        return this.repoPool.enqueue(() => {
          return this.getRepo(_path)
            .then(repo => {
              const checkoutOptions = new Git.CheckoutOptions()
              checkoutOptions.paths = [this.relativize(_path, wd)]
              checkoutOptions.checkoutStrategy = Git.Checkout.STRATEGY.FORCE | Git.Checkout.STRATEGY.DISABLE_PATHSPEC_MATCH
              return Git.Checkout.head(repo, checkoutOptions)
            })
        })
      })
      .then(() => this.refreshStatusForPath(_path))
      .then(() => { return })
  }

  // Public: Checks out a branch in your repository.
  //
  // * `reference` The {String} reference to checkout.
  // * `create`    A {Boolean} value which, if true creates the new reference if
  //   it doesn't exist.
  //
  // Returns a {Promise} that resolves if the method was successful.
  public checkoutReference (reference: string, create: boolean): Promise<void> {
    return this.repoPool.enqueue(() => {
      return this.getRepo()
        .then(repo => repo.checkoutBranch(reference))
    })
    .catch(error => {
      if (create) {
        return this._createBranch(reference)
          .then(_ => this.checkoutReference(reference, false))
      } else {
        throw error
      }
    })
    .then(_ => null)
  }

  // Create a new branch with the given name.
  //
  // * `name` The {String} name of the new branch.
  //
  // Returns a {Promise} which resolves to a {NodeGit.Ref} reference to the
  // created branch.
  private _createBranch (name: string): Promise<any> {
    return this.repoPool.enqueue(() => {
      return this.getRepo()
        .then(repo => Promise.all([repo, repo.getHeadCommit()]))
        .then(([repo, commit]) => repo.createBranch(name, commit))
    })
  }

  // Get all the hunks in the diff.
  //
  // * `diff` The {NodeGit.Diff} whose hunks should be retrieved.
  //
  // Returns a {Promise} which resolves to an {Array} of {NodeGit.Hunk}.
  private _getDiffHunks (diff: any): Promise<any> {
    return diff.patches()
      .then((patches: any[]) => Promise.all(patches.map(p => p.hunks()))) // patches :: Array<Patch>
      .then((hunks: any[]) => _.flatten(hunks)) // hunks :: Array<Array<Hunk>>
  }

  // Get all the lines contained in the diff.
  //
  // * `diff` The {NodeGit.Diff} use lines should be retrieved.
  //
  // Returns a {Promise} which resolves to an {Array} of {NodeGit.Line}.
  private _getDiffLines (diff: any): Promise<any> {
    return this._getDiffHunks(diff)
      .then(hunks => Promise.all(hunks.map((h: any) => h.lines())))
      .then(lines => _.flatten(lines)) // lines :: Array<Array<Line>>
  }

  // Diff the given blob and buffer with the provided options.
  //
  // * `blob` The {NodeGit.Blob}
  // * `buffer` The {String} buffer.
  // * `options` The {NodeGit.DiffOptions}
  //
  // Returns a {Promise} which resolves to an {Array} of {Object}s which have
  // the following keys:
  //   * `oldStart` The {Number} of the old starting line.
  //   * `newStart` The {Number} of the new starting line.
  //   * `oldLines` The {Number} of old lines.
  //   * `newLines` The {Number} of new lines.
  private _diffBlobToBuffer (blob: any, buffer: string, options: Object): {oldStart: number, newStart: number, oldLines: number, newLines: number}[] {
    const hunks: any[] = []
    const hunkCallback = (delta: any, hunk: any, payload: any) => {
      hunks.push({
        oldStart: hunk.oldStart(),
        newStart: hunk.newStart(),
        oldLines: hunk.oldLines(),
        newLines: hunk.newLines()
      })
    }

    return Git.Diff.blobToBuffer(blob, null, buffer, null, options, null, null, hunkCallback, null)
      .then(() => hunks)
  }

  // Get the current branch and update this.branch.
  //
  // Returns a {Promise} which resolves to a {boolean} indicating whether the
  // branch name changed.
  private _refreshBranch (): Promise<boolean> {
    return this.repoPool.enqueue(() => {
      return this.getRepo()
        .then(repo => repo.getCurrentBranch())
        .then(ref => ref.name())
        .then(branchName => {
          const changed = branchName !== this.branch
          this.branch = branchName
          return changed
        })
    })
  }

  // Refresh the cached ahead/behind count with the given branch.
  //
  // * `branchName` The {String} name of the branch whose ahead/behind should be
  //                used for the refresh.
  //
  // Returns a {Promise} which will resolve to a {boolean} indicating whether
  // the ahead/behind count changed.
  private _refreshAheadBehindCount (branchName: string): Promise<boolean> {
    return this.getAheadBehindCount(branchName)
      .then(counts => {
        const changed = !_.isEqual(counts, this.upstream)
        this.upstream = counts
        return changed
      })
  }

  // Get the status for this repository.
  //
  // Returns a {Promise} that will resolve to an object of {String} paths to the
  // {Number} status.
  private _getRepositoryStatus (pathspecs: string[]): Promise<{[key: string]: number}> {
    return this._getStatus(pathspecs.length > 0 ? pathspecs : null)
      .then(statuses => {
        const statusPairs = statuses.map(status => [status.path(), status.statusBit()])
        return _.object(statusPairs)
      })
  }

  // Get the status for the given submodule.
  //
  // * `submodule` The {Repository} for the submodule.
  //
  // Returns a {Promise} which resolves to an {Object}, keyed by {String}
  // repo-relative {Number} statuses.
  private async _getSubmoduleStatus (submodule: Repository): Promise<{[key: string]: number}> {
    // At this point, we've called submodule._refreshSubmodules(), which would
    // have refreshed the status on *its* submodules, etc. So we know that its
    // cached path statuses are up-to-date.
    //
    // Now we just need to hoist those statuses into our repository by changing
    // their paths to be relative to us.

    const statuses = submodule.getCachedPathStatuses()
    const repoRelativeStatuses = {}
    const submoduleRepo = await submodule.getRepo()
    const submoduleWorkDir = submoduleRepo.workdir()
    for (const relativePath in statuses) {
      const statusBit = statuses[relativePath]
      const absolutePath = path.join(submoduleWorkDir, relativePath)
      const repoRelativePath = await this.relativizeToWorkingDirectory(absolutePath)
      repoRelativeStatuses[repoRelativePath] = statusBit
    }

    return repoRelativeStatuses
  }

  // Refresh the list of submodules in the repository.
  //
  // Returns a {Promise} which resolves to an {Array} of {Repository} values.
  private async _refreshSubmodules (): Promise<Repository[]> {
    const repo = await this.getRepo()
    const wd = await this.getWorkingDirectory()
    const submoduleNames = await repo.getSubmoduleNames()
    for (const name of submoduleNames) {
      const alreadyExists = Boolean(this.submodules[name])
      if (alreadyExists) { continue }

      const submodule = await Git.Submodule.lookup(repo, name)
      const absolutePath = path.join(wd, submodule.path())
      const submoduleRepo = Repository.open(absolutePath, {openExactPath: true})
      this.submodules[name] = submoduleRepo
    }

    for (const name in this.submodules) {
      const repo = this.submodules[name]
      const gone = submoduleNames.indexOf(name) < 0
      if (gone) {
        repo.destroy()
        delete this.submodules[name]
      } else {
        try {
          await repo.refreshStatus()
        } catch (e) {
          // libgit2 will sometimes report submodules that aren't actually valid
          // (https://github.com/libgit2/libgit2/issues/3580). So check the
          // validity of the submodules by removing any that fail.
          repo.destroy()
          delete this.submodules[name]
        }
      }
    }

    return _.values(this.submodules)
  }

  // Get the status for the submodules in the repository.
  //
  // Returns a {Promise} that will resolve to an object of {String} paths to the
  // {Number} status.
  private _getSubmoduleStatuses (): Promise<{[key: string]: number}> {
    return this._refreshSubmodules()
      .then(repos => {
        return Promise.all(repos.map(repo => this._getSubmoduleStatus(repo)))
      })
      .then(statuses => _.extend({}, ...statuses))
  }

  // Refresh the cached status.
  //
  // Returns a {Promise} which will resolve to a {boolean} indicating whether
  // any statuses changed.
  private _refreshStatus (pathspecs: string[]): Promise<boolean> {
    return Promise.all([this._getRepositoryStatus(pathspecs), this._getSubmoduleStatuses()])
      .then(([repositoryStatus, submoduleStatus]) => {
        const statusesByPath = _.extend({}, repositoryStatus, submoduleStatus)
        const changed = !_.isEqual(this.pathStatusCache, statusesByPath)
        this.pathStatusCache = statusesByPath
        return changed
      })
  }

  // Refreshes the git status.
  //
  // * `pathspecs` The {String} pathspecs whose status should be refreshed.
  //
  // Returns a {Promise} which will resolve when refresh is complete.
  public refreshStatus (pathspecs?: string[]): Promise<void> {
    const status = this._refreshStatus(pathspecs || [])
    const branch = this._refreshBranch()
    const aheadBehind = branch.then(() => this._refreshAheadBehindCount(this.branch))

    this._refreshingPromise = this._refreshingPromise.then(_ => {
      return Promise.all([status, branch, aheadBehind])
        .then(([statusChanged, branchChanged, aheadBehindChanged]) => {
          if (this.emitter && (statusChanged || branchChanged || aheadBehindChanged)) {
            this.emitter.emit('did-change-statuses')
          }

          return null
        })
        // Because all these refresh steps happen asynchronously, it's entirely
        // possible the repository was destroyed while we were working. In which
        // case we should just swallow the error.
        .catch(e => {
          if (this._isDestroyed()) {
            return null
          } else {
            return Promise.reject(e)
          }
        })
        .catch(e => {
          console.error('Error refreshing repository status:')
          console.error(e)
          return Promise.reject(e)
        })
    })
    return this._refreshingPromise
  }

  // Get the submodule for the given path.
  //
  // Returns a {Promise} which resolves to the {Repository} submodule or
  // null if it isn't a submodule path.
  private async _submoduleForPath (_path: string): Promise<Repository> {
    let relativePath = await this.relativizeToWorkingDirectory(_path)
    for (const submodulePath in this.submodules) {
      const submoduleRepo = this.submodules[submodulePath]
      if (relativePath === submodulePath) {
        return submoduleRepo
      } else if (relativePath.indexOf(`${submodulePath}/`) === 0) {
        relativePath = relativePath.substring(submodulePath.length + 1)
        const innerSubmodule = await submoduleRepo._submoduleForPath(relativePath)
        return innerSubmodule || submoduleRepo
      }
    }

    return null
  }

  // Get the NodeGit repository for the given path.
  //
  // * `path` The optional {String} path within the repository. This is only
  //          needed if you want to get the repository for that path if it is a
  //          submodule.
  //
  // Returns a {Promise} which resolves to the {NodeGit.Repository}.
  public getRepo (_path?: string | null): Promise<NodeGitRepository> {
    if (this._isDestroyed()) {
      const error = new Error('Repository has been destroyed')
      error.name = Repository.DestroyedErrorName
      return Promise.reject(error)
    }

    if (!_path) { return this.repoPromise }

    return this._submoduleForPath(_path)
      .then(submodule => submodule ? submodule.getRepo() : this.repoPromise)
  }

  // Open a new instance of the underlying {NodeGit.Repository}.
  //
  // By opening multiple connections to the same underlying repository, users
  // can safely access the same repository concurrently.
  //
  // Returns the new {NodeGit.Repository}.
  public openRepository (): NodeGitRepository {
    if (this.openExactPath) {
      return Git.Repository.open(this.openedPath)
    } else {
      return Git.Repository.openExt(this.openedPath, 0, '')
    }
  }

  private async getRepoPool(_path?: string | null): Promise<ResourcePool<NodeGitRepository>> {
    if (!_path) {
      return this.repoPool
    }

    const submodule = await this._submoduleForPath(_path)
    if (submodule) {
      return submodule.repoPool
    } else {
      return this.repoPool
    }
  }

  public async enqueue<V>(fn: (repo: NodeGitRepository) => V, _path?: string | null): Promise<V> {
    const pool = await this.getRepoPool(_path)
    return pool.enqueue<V>(repoPromise => {
      return repoPromise.then((repo: NodeGitRepository) => fn(repo))
    })
  }

  // Section: Private
  // ================

  // Has the repository been destroyed?
  //
  // Returns a {Boolean}.
  public _isDestroyed (): boolean {
    return this.repoPromise == null
  }

  // Get the status for the given paths.
  //
  // * `paths` The {String} paths whose status is wanted. If undefined, get the
  //           status for the whole repository.
  //
  // Returns a {Promise} which resolves to an {Array} of {NodeGit.StatusFile}
  // statuses for the paths.
  private _getStatus (paths: string[]): Promise<any[]> {
    return this.repoPool.enqueue(() => {
      return this.getRepo()
        .then(repo => {
          const opts = {
            flags: Git.Status.OPT.INCLUDE_UNTRACKED | Git.Status.OPT.RECURSE_UNTRACKED_DIRS
          }

          if (paths) {
            opts['pathspec'] = paths
          }

          return repo.getStatusExt(opts)
        })
    })
  }
}
