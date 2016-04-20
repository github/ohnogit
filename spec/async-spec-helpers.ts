// Lifted from Atom

export function asyncBeforeEach(action: () => any, timeout?: number): void {
  beforeEach(asyncAction(action), timeout)
}

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

export function asyncIt(expectation: string, assertion: () => any, timeout?: number): void {
  it(expectation, asyncAction(assertion), timeout)
}

export function fasyncIt(expectation: string, assertion: () => any, timeout?: number): void {
  fit(expectation, asyncAction(assertion), timeout)
}

export function wait(delay: number): Promise<any> {
  return new Promise((resolve: Function, reject: Function) => {
    setTimeout(() => {
      resolve()
    }, delay)
  })
}
