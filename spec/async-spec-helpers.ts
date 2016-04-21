// Lifted from Atom

declare namespace NodeJS  {
  interface Global {
    beforeEach: (action: (done: DoneFn) => any, timeout?: number) => void
    it: (expectation: string, assertion?: (done: DoneFn) => any, timeout?: number) => void
    fit: (expectation: string, assertion?: (done: DoneFn) => any, timeout?: number) => void
    wait: (delay: number) => Promise<any>
  }
}

// Swap out `beforeEach`
type OriginalBeforeEachType = (action: (done: DoneFn) => void, timeout?: number) => void
const originalBeforeEach: OriginalBeforeEachType = beforeEach

global.beforeEach = function(action: () => any, timeout?: number): void {
  originalBeforeEach(asyncAction(action), timeout)
}


// Swap out `it`
type OriginalItType = (expectation: string, assertion?: (done: DoneFn) => void, timeout?: number) => void
const originalIt: OriginalItType = it

global.it = function(expectation: string, assertion: () => any, timeout?: number): void {
  originalIt(expectation, asyncAction(assertion), timeout)
}


// Swap out `fit`
type OriginalFitType = (expectation: string, assertion?: (done: DoneFn) => void, timeout?: number) => void
const originalFit: OriginalFitType = fit

global.fit = function (expectation: string, assertion: () => any, timeout?: number): void {
  originalFit(expectation, asyncAction(assertion), timeout)
}


function wait(delay: number): Promise<any> {
  return new Promise((resolve: Function, reject: Function) => {
    setTimeout(() => {
      resolve()
    }, delay)
  })
}
global.wait = wait

function asyncAction(action: () => any): (done: Function) => any {
  return done => {
    const result = action()
    if (result instanceof Promise) {
      result.then(done).catch((e: Error) => {
        fail(e)
        done()
      })
    } else {
      done()
    }
  }
}
