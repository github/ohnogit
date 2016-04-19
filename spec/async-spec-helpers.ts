// Lifted from Atom

export function asyncBeforeEach(action: () => any, timeout?: number): void {
  beforeEach(done => {
    const result = action()
    if (result instanceof Promise) {
      result.then(done)
    } else {
      done()
    }
  }, timeout)
}

export function asyncIt(expectation: string, assertion: () => any, timeout?: number): void {
  it(expectation, done => {
    const result = assertion()
    if (result instanceof Promise) {
      result.then(done)
    } else {
      done()
    }
  }, timeout)
}

export function wait(delay: number): Promise<any> {
  return new Promise((resolve: Function, reject: Function) => {
    setTimeout(() => {
      resolve()
    }, delay)
  })
}
