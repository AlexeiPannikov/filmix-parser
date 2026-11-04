import type http from 'node:http';

/**
 * Serves `payload`, honouring a Range request: 206 + Content-Range for a valid
 * `Range: bytes=<start>-`, 416 when start is at or past EOF, and 200 with the
 * full body when no Range was sent.
 */
export function rangeAwareHandler(payload: Buffer, counter?: { rangeRequests: number }): http.RequestListener {
  return (req, res) => {
    const range = req.headers.range;
    if (range === undefined) {
      res.writeHead(200, { 'Content-Length': String(payload.length), 'Accept-Ranges': 'bytes' });
      res.end(payload);
      return;
    }
    if (counter !== undefined) counter.rangeRequests++;
    const prefix = 'bytes=';
    if (!range.startsWith(prefix)) {
      res.writeHead(400);
      res.end('bad range');
      return;
    }
    const start = Number.parseInt(range.slice(prefix.length).split('-')[0] ?? '', 10);
    if (Number.isNaN(start) || start < 0) {
      res.writeHead(400);
      res.end('bad range');
      return;
    }
    if (start >= payload.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${payload.length}` });
      res.end();
      return;
    }
    const end = payload.length - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${payload.length}`,
      'Content-Length': String(end - start + 1),
    });
    res.end(payload.subarray(start));
  };
}
