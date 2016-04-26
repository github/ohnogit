import * as path from 'path'

import Repository from '../lib/repository'
import './async-spec-helpers'

const fs = require('fs-plus')
const temp = require('temp')
const Git = require('nodegit')

temp.track()

function getFixturePath(name: string): string {
  return path.join(__dirname, '..', '..', 'spec', 'fixtures', name)
}

function openFixture (fixture: string): Repository {
  return Repository.open(getFixturePath(fixture))
}

function copyRepository (name = 'working-dir'): string {
  const workingDirPath = temp.mkdirSync('git-working-dir')
  fs.copySync(getFixturePath(name), workingDirPath)
  fs.renameSync(path.join(workingDirPath, 'git.git'), path.join(workingDirPath, '.git'))
  return fs.realpathSync(workingDirPath)
}

function copySubmoduleRepository () {
  const workingDirectory = copyRepository('repo-with-submodules')
  const reGit = (name: string) => {
    fs.renameSync(path.join(workingDirectory, name, 'git.git'), path.join(workingDirectory, name, '.git'))
  }
  reGit('jstips')
  reGit('You-Dont-Need-jQuery')

  return workingDirectory
}

describe('Repository', () => {
  let repo: Repository

  afterEach(() => {
    if (repo) {
      repo.destroy()
    }
  })

  describe('@open(path)', () => {
    it('should throw when no repository is found', async () => {
      repo = Repository.open(path.join(temp.dir, 'nogit.txt'))

      let threw = false
      try {
        await repo.repoPromise
      } catch (e) {
        threw = true
      }

      expect(threw).toBe(true)
    })
  })

  describe('.getRepo()', () => {
    let workingDirectory: string

    beforeEach(async () => {
      workingDirectory = copySubmoduleRepository()
      repo = Repository.open(workingDirectory)
      await repo.refreshStatus()
    })

    it('returns the repository when not given a path', async () => {
      const nodeGitRepo1 = await repo.repoPromise
      const nodeGitRepo2 = await repo.getRepo()
      expect(nodeGitRepo1.workdir()).toBe(nodeGitRepo2.workdir())
    })

    it('returns the repository when given a non-submodule path', async () => {
      const nodeGitRepo1 = await repo.repoPromise
      const nodeGitRepo2 = await repo.getRepo('README')
      expect(nodeGitRepo1.workdir()).toBe(nodeGitRepo2.workdir())
    })

    it('returns the submodule repository when given a submodule path', async () => {
      const nodeGitRepo1 = await repo.repoPromise
      const nodeGitRepo2 = await repo.getRepo('jstips')
      expect(nodeGitRepo1.workdir()).not.toBe(nodeGitRepo2.workdir())

      const nodeGitRepo3 = await repo.getRepo('jstips/README.md')
      expect(nodeGitRepo1.workdir()).not.toBe(nodeGitRepo3.workdir())
      expect(nodeGitRepo2.workdir()).toBe(nodeGitRepo3.workdir())
    })
  })

  describe('.openRepository()', () => {
    it('returns a new repository instance', async () => {
      repo = openFixture('master.git')

      const originalRepo = await repo.getRepo()
      expect(originalRepo).not.toBeNull()

      const nodeGitRepo = repo.openRepository()
      expect(nodeGitRepo).not.toBeNull()
      expect(originalRepo).not.toBe(nodeGitRepo)
    })
  })

  describe('.getPath()', () => {
    it('returns the repository path for a repository path', async () => {
      repo = openFixture('master.git')
      const repoPath = await repo.getPath()
      expect(repoPath).toBe(getFixturePath('master.git'))
    })
  })

  describe('.isPathIgnored(path)', () => {
    beforeEach(() => {
      repo = openFixture('ignore.git')
    })

    it('resolves true for an ignored path', async () => {
      const ignored = await repo.isPathIgnored('a.txt')
      expect(ignored).toBe(true)
    })

    it('resolves false for a non-ignored path', async () => {
      const ignored = await repo.isPathIgnored('b.txt')
      expect(ignored).toBe(false)
    })
  })

  describe('.isPathModified(path)', () => {
    let filePath: string
    let newPath: string
    let emptyPath: string

    beforeEach(() => {
      const workingDirPath = copyRepository()
      repo = Repository.open(workingDirPath)
      filePath = path.join(workingDirPath, 'a.txt')
      newPath = path.join(workingDirPath, 'new-path.txt')
      fs.writeFileSync(newPath, "i'm new here")
      emptyPath = path.join(workingDirPath, 'empty-path.txt')
    })

    describe('when the path is unstaged', () => {
      it('resolves false if the path has not been modified', async () => {
        const modified = await repo.isPathModified(filePath)
        expect(modified).toBe(false)
      })

      it('resolves true if the path is modified', async () => {
        fs.writeFileSync(filePath, 'change')
        const modified = await repo.isPathModified(filePath)
        expect(modified).toBe(true)
      })

      it('resolves false if the path is new', async () => {
        const modified = await repo.isPathModified(newPath)
        expect(modified).toBe(false)
      })

      it('resolves false if the path is invalid', async () => {
        const modified = await repo.isPathModified(emptyPath)
        expect(modified).toBe(false)
      })
    })
  })

  describe('.isPathNew(path)', () => {
    let newPath: string

    beforeEach(() => {
      const workingDirPath = copyRepository()
      repo = Repository.open(workingDirPath)
      newPath = path.join(workingDirPath, 'new-path.txt')
      fs.writeFileSync(newPath, "i'm new here")
    })

    describe('when the path is unstaged', () => {
      it('returns true if the path is new', async () => {
        const isNew = await repo.isPathNew(newPath)
        expect(isNew).toBe(true)
      })

      it("returns false if the path isn't new", async () => {
        const modified = await repo.isPathModified(newPath)
        expect(modified).toBe(false)
      })
    })
  })

  describe('.checkoutHead(path)', () => {
    let filePath: string

    beforeEach(() => {
      const workingDirPath = copyRepository()
      repo = Repository.open(workingDirPath)
      filePath = path.join(workingDirPath, 'a.txt')
    })

    it('no longer reports a path as modified after checkout', async () => {
      let modified = await repo.isPathModified(filePath)
      expect(modified).toBe(false)

      fs.writeFileSync(filePath, 'ch ch changes')

      modified = await repo.isPathModified(filePath)
      expect(modified).toBe(true)

      await repo.checkoutHead(filePath)

      modified = await repo.isPathModified(filePath)
      expect(modified).toBe(false)
    })

    it('restores the contents of the path to the original text', async () => {
      fs.writeFileSync(filePath, 'ch ch changes')
      await repo.checkoutHead(filePath)
      expect(fs.readFileSync(filePath, 'utf8')).toBe('')
    })

    it('fires a did-change-status event if the checkout completes successfully', async () => {
      fs.writeFileSync(filePath, 'ch ch changes')

      await repo.refreshStatusForPath(filePath)

      const statusHandler = jasmine.createSpy('statusHandler')
      repo.onDidChangeStatus(statusHandler)

      await repo.checkoutHead(filePath)

      expect(statusHandler.calls.count()).toBe(1)
      expect(statusHandler).toHaveBeenCalledWith({path: filePath, pathStatus: 0})

      await repo.checkoutHead(filePath)
      expect(statusHandler.calls.count()).toBe(1)
    })
  })

  describe('.destroy()', () => {
    beforeEach(() => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    it('throws an exception when any method is called after it is called', async () => {
      repo.destroy()

      let error: Error = null
      try {
        await repo.getShortHead()
      } catch (e) {
        error = e
      }

      expect(error.name).toBe(Repository.DestroyedErrorName)

      repo = null
    })
  })

  describe('.getPathStatus(path)', () => {
    let filePath: string

    beforeEach(() => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
      filePath = path.join(workingDirectory, 'file.txt')
    })

    it('trigger a status-changed event when the new status differs from the last cached one', async () => {
      const statusHandler = jasmine.createSpy('statusHandler')
      repo.onDidChangeStatus(statusHandler)
      fs.writeFileSync(filePath, '')

      await repo.getPathStatus(filePath)

      expect(statusHandler.calls.count()).toBe(1)
      const status = Git.Status.STATUS.WT_MODIFIED
      expect(statusHandler).toHaveBeenCalledWith({path: filePath, pathStatus: status})
      fs.writeFileSync(filePath, 'abc')

      await repo.getPathStatus(filePath)
      expect(statusHandler.calls.count()).toBe(1)
    })
  })

  describe('.getDirectoryStatus(path)', () => {
    let directoryPath: string
    let filePath: string

    beforeEach(() => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
      directoryPath = path.join(workingDirectory, 'dir')
      filePath = path.join(directoryPath, 'b.txt')
    })

    it('gets the status based on the files inside the directory', async () => {
      await repo.checkoutHead(filePath)

      let result = await repo.getDirectoryStatus(directoryPath)
      expect(repo.isStatusModified(result)).toBe(false)

      fs.writeFileSync(filePath, 'abc')

      result = await repo.getDirectoryStatus(directoryPath)
      expect(repo.isStatusModified(result)).toBe(true)
    })
  })

  describe('.refreshStatus()', () => {
    let newPath: string
    let modifiedPath: string
    let cleanPath: string
    let workingDirectory: string

    beforeEach(() => {
      workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
      modifiedPath = path.join(workingDirectory, 'file.txt')
      newPath = path.join(workingDirectory, 'untracked.txt')
      cleanPath = path.join(workingDirectory, 'other.txt')
      fs.writeFileSync(cleanPath, 'Full of text')
      fs.writeFileSync(newPath, '')
      fs.writeFileSync(modifiedPath, 'making this path modified')
      newPath = fs.absolute(newPath) // specs could be running under symbol path.
    })

    it('returns status information for all new and modified files', async () => {
      await repo.refreshStatus()

      expect(await repo.getCachedPathStatus(cleanPath)).toBeUndefined()
      expect(repo.isStatusNew(await repo.getCachedPathStatus(newPath))).toBe(true)
      expect(repo.isStatusModified(await repo.getCachedPathStatus(modifiedPath))).toBe(true)
    })

    describe('in a repository with submodules', () => {
      beforeEach(() => {
        workingDirectory = copySubmoduleRepository()
        repo = Repository.open(workingDirectory)
        modifiedPath = path.join(workingDirectory, 'jstips', 'README.md')
        newPath = path.join(workingDirectory, 'You-Dont-Need-jQuery', 'untracked.txt')
        cleanPath = path.join(workingDirectory, 'jstips', 'CONTRIBUTING.md')
        fs.writeFileSync(newPath, '')
        fs.writeFileSync(modifiedPath, 'making this path modified')
        newPath = fs.absolute(newPath) // specs could be running under symbol path.
      })

      it('returns status information for all new and modified files', async () => {
        await repo.refreshStatus()

        expect(await repo.getCachedPathStatus(cleanPath)).toBeUndefined()
        expect(repo.isStatusNew(await repo.getCachedPathStatus(newPath))).toBe(true)
        expect(repo.isStatusModified(await repo.getCachedPathStatus(modifiedPath))).toBe(true)
      })
    })

    it('emits did-change-statuses if the status changes', async () => {
      const someNewPath = path.join(workingDirectory, 'MyNewJSFramework.md')
      fs.writeFileSync(someNewPath, '')

      const statusHandler = jasmine.createSpy('statusHandler')
      repo.onDidChangeStatuses(statusHandler)

      await repo.refreshStatus()

      await wait(0)

      expect(statusHandler.calls.count()).toBeGreaterThan(0)
    })

    it('emits did-change-statuses if the branch changes', async () => {
      const statusHandler = jasmine.createSpy('statusHandler')
      repo.onDidChangeStatuses(statusHandler)

      repo._refreshBranch = jasmine.createSpy('_refreshBranch').and.callFake(() => {
        return Promise.resolve(true)
      })

      await repo.refreshStatus()

      await wait(0)

      expect(statusHandler.calls.count()).toBeGreaterThan(0)
    })

    it('emits did-change-statuses if the ahead/behind changes', async () => {
      const statusHandler = jasmine.createSpy('statusHandler')
      repo.onDidChangeStatuses(statusHandler)

      repo._refreshAheadBehindCount = jasmine.createSpy('_refreshAheadBehindCount').and.callFake(() => {
        return Promise.resolve(true)
      })

      await repo.refreshStatus()

      await wait(0)

      expect(statusHandler.calls.count()).toBeGreaterThan(0)
    })
  })

  describe('Repository::relativize(filePath, workdir)', () => {
    beforeEach(() => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    // This is a change in implementation from the git-utils version
    it('just returns path if workdir is not provided', () => {
      const _path = '/foo/bar/baz.txt'
      const relPath = repo.relativize(_path)
      expect(_path).toEqual(relPath)
    })

    it('relativizes a repo path', () => {
      const workdir = '/tmp/foo/bar/baz/'
      const relativizedPath = repo.relativize(`${workdir}a/b.txt`, workdir)
      expect(relativizedPath).toBe('a/b.txt')
    })

    it("doesn't require workdir to end in a slash", () => {
      const workdir = '/tmp/foo/bar/baz'
      const relativizedPath = repo.relativize(`${workdir}/a/b.txt`, workdir)
      expect(relativizedPath).toBe('a/b.txt')
    })

    it('preserves file case', () => {
      repo.isCaseInsensitive = true

      const workdir = '/tmp/foo/bar/baz/'
      const relativizedPath = repo.relativize(`${workdir}a/README.txt`, workdir)
      expect(relativizedPath).toBe('a/README.txt')
    })
  })

  describe('.getShortHead(path)', () => {
    beforeEach(() => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    it('returns the human-readable branch name', async () => {
      const head = await repo.getShortHead()
      expect(head).toBe('master')
    })

    describe('in a submodule', () => {
      beforeEach(() => {
        const workingDirectory = copySubmoduleRepository()
        repo = Repository.open(workingDirectory)
      })

      it('returns the human-readable branch name', async () => {
        await repo.refreshStatus()

        const head = await repo.getShortHead('jstips')
        expect(head).toBe('test')
      })
    })
  })

  describe('.isSubmodule(path)', () => {
    beforeEach(() => {
      const workingDirectory = copySubmoduleRepository()
      repo = Repository.open(workingDirectory)
    })

    it("returns false for a path that isn't a submodule", async () => {
      const isSubmodule = await repo.isSubmodule('README')
      expect(isSubmodule).toBe(false)
    })

    it('returns true for a path that is a submodule', async () => {
      const isSubmodule = await repo.isSubmodule('jstips')
      expect(isSubmodule).toBe(true)
    })
  })

  describe('.getAheadBehindCount(reference, path)', () => {
    beforeEach(() => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    it('returns 0, 0 for a branch with no upstream', async () => {
      const {ahead, behind} = await repo.getAheadBehindCount('master')
      expect(ahead).toBe(0)
      expect(behind).toBe(0)
    })
  })

  describe('.getCachedUpstreamAheadBehindCount(path)', () => {
    beforeEach(() => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    it('returns 0, 0 for a branch with no upstream', async () => {
      await repo.refreshStatus()

      const {ahead, behind} = await repo.getCachedUpstreamAheadBehindCount()
      expect(ahead).toBe(0)
      expect(behind).toBe(0)
    })

    describe('in a submodule', () => {
      beforeEach(() => {
        const workingDirectory = copySubmoduleRepository()
        repo = Repository.open(workingDirectory)
      })

      it('returns 1, 0 for a branch which is ahead by 1', async () => {
        await repo.refreshStatus()

        const {ahead, behind} = await repo.getCachedUpstreamAheadBehindCount('You-Dont-Need-jQuery')
        expect(ahead).toBe(1)
        expect(behind).toBe(0)
      })
    })
  })

  describe('.getDiffStats(path)', () => {
    let workingDirectory: string

    beforeEach(() => {
      workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    it('returns the diff stat', async () => {
      const filePath = path.join(workingDirectory, 'a.txt')
      fs.writeFileSync(filePath, 'change')

      const {added, deleted} = await repo.getDiffStats('a.txt')
      expect(added).toBe(1)
      expect(deleted).toBe(0)
    })
  })

  describe('.hasBranch(branch)', () => {
    beforeEach(() => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    it('resolves true when the branch exists', async () => {
      const hasBranch = await repo.hasBranch('master')
      expect(hasBranch).toBe(true)
    })

    it("resolves false when the branch doesn't exist", async () => {
      const hasBranch = await repo.hasBranch('trolleybus')
      expect(hasBranch).toBe(false)
    })
  })

  describe('.getReferences(path)', () => {
    beforeEach(() => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    it('returns the heads, remotes, and tags', async () => {
      const {heads, remotes, tags} = await repo.getReferences()
      expect(heads.length).toBe(1)
      expect(remotes.length).toBe(0)
      expect(tags.length).toBe(0)
    })
  })

  describe('.getReferenceTarget(reference, path)', () => {
    beforeEach(() => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    it('returns the SHA target', async () => {
      const SHA = await repo.getReferenceTarget('refs/heads/master')
      expect(SHA).toBe('8a9c86f1cb1f14b8f436eb91f4b052c8802ca99e')
    })
  })

  describe('.getConfigValue(key, path)', () => {
    beforeEach(() => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    it('looks up the value for the key', async () => {
      const bare = await repo.getConfigValue('core.bare')
      expect(bare).toBe('false')
    })

    it("resolves to null if there's no value", async () => {
      const value = await repo.getConfigValue('my.special.key')
      expect(value).toBeNull()
    })
  })

  describe('.checkoutReference(reference, create)', () => {
    beforeEach(() => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    it('can create new branches', async () => {
      let success = false
      let threw = false
      await repo.checkoutReference('my-b', true)
        .then(_ => success = true)
        .catch(_ => threw = true)

      expect(success).toBe(true)
      expect(threw).toBe(false)
    })
  })

  describe('.createBranch', () => {
    beforeEach(() => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    it('can create new branches', async () => {
      let success = false
      let threw = false
      await repo.createBranch('my-b')
        .then(_ => success = true)
        .catch(_ => threw = true)

      expect(success).toBe(true)
      expect(threw).toBe(false)
    })
  })

  describe('.getLineDiffs(path, text)', () => {
    beforeEach(() => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    it('returns the old and new lines of the diff', async () => {
      const [{oldStart, newStart, oldLines, newLines}] = await repo.getLineDiffs('a.txt', 'hi there')
      expect(oldStart).toBe(0)
      expect(oldLines).toBe(0)
      expect(newStart).toBe(1)
      expect(newLines).toBe(1)
    })
  })

  describe('Repository::relativizeToWorkingDirectory(_path)', () => {
    let workingDirectory: string

    beforeEach(() => {
      workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    it('relativizes the given path to the working directory of the repository', async () => {
      let absolutePath = path.join(workingDirectory, 'a.txt')
      expect(await repo.relativizeToWorkingDirectory(absolutePath)).toBe('a.txt')
      absolutePath = path.join(workingDirectory, 'a/b/c.txt')
      expect(await repo.relativizeToWorkingDirectory(absolutePath)).toBe('a/b/c.txt')
      expect(await repo.relativizeToWorkingDirectory('a.txt')).toBe('a.txt')
      expect(await repo.relativizeToWorkingDirectory('/not/in/workdir')).toBe('/not/in/workdir')
      expect(await repo.relativizeToWorkingDirectory(null)).toBe(null)
      expect(await repo.relativizeToWorkingDirectory()).toBe(undefined)
      expect(await repo.relativizeToWorkingDirectory('')).toBe('')
      expect(await repo.relativizeToWorkingDirectory(workingDirectory)).toBe('')
    })

    describe('when the opened path is a symlink', () => {
      it('relativizes against both the linked path and real path', async () => {
        // Symlinks require admin privs on windows so we just skip this there,
        // done in git-utils as well
        if (process.platform === 'win32') {
          return
        }

        const linkDirectory = path.join(temp.mkdirSync('atom-working-dir-symlink'), 'link')
        fs.symlinkSync(workingDirectory, linkDirectory)
        const linkedRepo = Repository.open(linkDirectory)
        expect(await linkedRepo.relativizeToWorkingDirectory(path.join(workingDirectory, 'test1'))).toBe('test1')
        expect(await linkedRepo.relativizeToWorkingDirectory(path.join(linkDirectory, 'test2'))).toBe('test2')
        expect(await linkedRepo.relativizeToWorkingDirectory(path.join(linkDirectory, 'test2/test3'))).toBe('test2/test3')
        expect(await linkedRepo.relativizeToWorkingDirectory('test2/test3')).toBe('test2/test3')
      })

      it('handles case insensitive filesystems', async () => {
        repo.isCaseInsensitive = true
        expect(await repo.relativizeToWorkingDirectory(path.join(workingDirectory.toUpperCase(), 'a.txt'))).toBe('a.txt')
        expect(await repo.relativizeToWorkingDirectory(path.join(workingDirectory.toUpperCase(), 'a/b/c.txt'))).toBe('a/b/c.txt')
      })
    })
  })

  describe('.enqueue', () => {
    let workingDirectory: string

    beforeEach(() => {
      workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)
    })

    it('dequeues tasks', async () => {
      const result = await repo.enqueue(async (repo) => {
        const branch = await repo.getCurrentBranch()
        return branch.shorthand()
      })
      expect(result).toBe('master')
    })

    it('passes errors through', async () => {
      let threw = false
      try {
        await repo.enqueue(repo => Promise.reject(new Error()))
      } catch (e) {
        threw = true
      }
      expect(threw).toBe(true)
    })
  })

  describe('.getOriginURL()', () => {
    beforeEach(() => {
      const workingDirectory = copyRepository('repo-with-submodules')
      repo = Repository.open(workingDirectory)
    })

    it('returns the origin URL', async () => {
      const url = await repo.getOriginURL()
      expect(url).toBe('git@github.com:atom/some-repo-i-guess.git')
    })
  })

  describe('.getUpstreamBranch()', () => {
    it('returns null when there is no upstream branch', async () => {
      const workingDirectory = copyRepository()
      repo = Repository.open(workingDirectory)

      const upstream = await repo.getUpstreamBranch()
      expect(upstream).toBe(null)
    })

    it('returns the upstream branch', async () => {
      const workingDirectory = copyRepository('repo-with-submodules')
      repo = Repository.open(workingDirectory)

      const upstream = await repo.getUpstreamBranch()
      expect(upstream).toBe('refs/remotes/origin/master')
    })
  })
})
