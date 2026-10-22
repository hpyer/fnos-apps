// Status polling may return the same completed job many times.
export function createJobFeedback(notify) {
  let previous, message;
  return job => {
    const key = JSON.stringify([job.state, job.action, job.id, job.message]);
    if (key === previous) return;
    const initial = previous === undefined;
    previous = key;
    if (job.state === 'running') { message?.close(); return; }
    if (!['success', 'error'].includes(job.state) || (initial && job.state === 'success')) return;
    message?.close();
    message = notify({ type: job.state, content: job.message, duration: job.state === 'error' ? 0 : 5000 });
  };
}
