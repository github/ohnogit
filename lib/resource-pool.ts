export type WorkFunction<T, V> = (resource: T) => Promise<V>

// Manages a pool of some resource.
export default class ResourcePool<T> {
  private pool: T[]
  private queue: Array<(resource: T) => void>

  public constructor(pool: T[]) {
    this.pool = pool

    this.queue = []
  }

  // Enqueue the given function. The function will be given an object from the
  // pool. The function must return a {Promise}.
  public enqueue<V>(fn: WorkFunction<T, V>): Promise<V> {
    let resolve: (result: V) => void = null
    let reject: (error: Error) => void = null
    const wrapperPromise = new Promise<V>((resolve_, reject_) => {
      resolve = resolve_
      reject = reject_
    })

    this.queue.push(this.wrapFunction(fn, resolve, reject))

    this.dequeueIfAble()

    return wrapperPromise
  }

  private wrapFunction<V>(fn: WorkFunction<T, V>, resolve: (result: V) => void, reject: (error: Error) => void): (resource: T) => void {
    return (resource) => {
      const promise = fn(resource)
      promise
        .then(result => {
          resolve(result)
          this.taskDidComplete(resource)
        }, error => {
          reject(error)
          this.taskDidComplete(resource)
        })
    }
  }

  private taskDidComplete (resource: T) {
    this.pool.push(resource)

    this.dequeueIfAble()
  }

  private dequeueIfAble () {
    if (!this.pool.length || !this.queue.length) { return }

    const fn = this.queue.shift()
    const resource = this.pool.shift()
    fn(resource)
  }

  public getQueueDepth () { return this.queue.length }
}
