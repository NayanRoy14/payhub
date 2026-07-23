import { Queue, Worker, Job } from 'bullmq';
import { ProcessorName } from '../adapters/adapter.interface';

/**
 * Safety-net queue: if a processor's webhook never arrives (dropped, delayed,
 * misconfigured endpoint), a delayed job polls the processor directly via
 * adapter.verify() so the payment doesn't get stuck in 'processing'/'retrying'
 * forever. This is NOT on the critical path of the synchronous failover in
 * core/paymentService.ts — that happens immediately, decline-code-driven.
 */
export interface VerificationJobData {
  paymentId: string;
  processor: ProcessorName;
  processorRef: string;
}

const QUEUE_NAME = 'payment-verification';

let queue: Queue<VerificationJobData> | undefined;

function getConnection() {
  return { url: process.env.REDIS_URL ?? 'redis://localhost:6379' };
}

export function getRetryQueue(): Queue<VerificationJobData> {
  if (!queue) {
    queue = new Queue<VerificationJobData>(QUEUE_NAME, { connection: getConnection() });
  }
  return queue;
}

export async function scheduleVerification(data: VerificationJobData, delayMs = 30_000): Promise<void> {
  await getRetryQueue().add('verify', data, { delay: delayMs, attempts: 1 });
}

export function startVerificationWorker(onJob: (data: VerificationJobData) => Promise<void>): Worker<VerificationJobData> {
  return new Worker<VerificationJobData>(
    QUEUE_NAME,
    async (job: Job<VerificationJobData>) => {
      await onJob(job.data);
    },
    { connection: getConnection() }
  );
}
