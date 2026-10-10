import net from 'node:net';

/**
 * Loopback gateway for the Docker deployment. The application and sink sit on
 * an internal-only network with no route out; this forwarder is the single
 * bridge, publishing them to the host's loopback interface.
 * FORWARDS format: "listenPort:targetHost:targetPort,..."
 */
for (const spec of (process.env.FORWARDS ?? '').split(',').filter(Boolean)) {
  const [listen, host, port] = spec.split(':');
  net
    .createServer((client) => {
      const upstream = net.connect(Number(port), host);
      client.pipe(upstream).pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', close);
      upstream.on('error', close);
    })
    .listen(Number(listen), '0.0.0.0', () => console.log(`gateway :${listen} -> ${host}:${port}`));
}
