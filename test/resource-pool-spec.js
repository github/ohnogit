import test from 'ava'

import ResourcePool from '../build/resource-pool'

let queue

test.beforeEach(() => {
  queue = new ResourcePool([{}])
})

test('enqueue calls the enqueued function', async t => {
  let called = false
  await queue.enqueue(() => {
    called = true
    return Promise.resolve()
  })
  t.true(called)
})

test('enqueue forwards values from the inner promise', async t => {
  const result = await queue.enqueue(() => Promise.resolve(42))
  t.is(result, 42)
})

test('enqueue forwards errors from the inner promise', async t => {
  let threw = false
  try {
    await queue.enqueue(() => Promise.reject(new Error('down with the sickness')))
  } catch (e) {
    threw = true
  }
  t.true(threw)
})

test('enqueue continues to dequeue work after a promise has been rejected', async t => {
  try {
    await queue.enqueue(() => Promise.reject(new Error('down with the sickness')))
  } catch (e) {}

  const result = await queue.enqueue(() => Promise.resolve(42))
  t.is(result, 42)
})

test('enqueue queues up work', async t => {
  queue.enqueue(() => new Promise((resolve, reject) => {}))
  t.is(queue.getQueueDepth(), 0)

  queue.enqueue(() => new Promise((resolve, reject) => {}))
  t.is(queue.getQueueDepth(), 1)

  queue.enqueue(() => new Promise((resolve, reject) => {}))
  t.is(queue.getQueueDepth(), 2)
})
