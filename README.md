# OhNoGit

For when you have to use git in nodejs.

A wrapper around [nodegit](https://github.com/nodegit/nodegit).

![](http://www.reactiongifs.com/r/whid1.gif)

## Install

To use:

```
npm install ohnogit --save
```

```js
import {Repository} from 'ohnogit'

const repo = Repository.open('path/to/repository')
await repo.refreshStatus()
```

For development:

```
git clone https://github.com/github/ohnogit
npm install
```
