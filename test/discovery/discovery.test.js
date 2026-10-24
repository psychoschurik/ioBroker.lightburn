const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { discoveryHosts, probeHost, scanNetwork } = require('../../build/discovery');

test('subnets are bounded, private and normalized', () => {
    const hosts = discoveryHosts('192.168.23.213/24');
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], '192.168.23.1');
    assert.equal(hosts.at(-1), '192.168.23.254');
    assert.deepEqual(discoveryHosts('10.0.0.1/32'), ['10.0.0.1']);
    assert.deepEqual(discoveryHosts('172.16.0.0/31'), ['172.16.0.0', '172.16.0.1']);
    for (const subnet of [
        '8.8.8.8/24',
        '192.168.0.0/16',
        'localhost/24',
        '10.0.0.1/',
        '10.0.0.1/24/x',
        '10.0.0.999/24',
    ]) {
        assert.throws(() => discoveryHosts(subnet));
    }
});

test('HTTP discovery distinguishes candidates, avoids auth and does not follow redirects', async () => {
    let mode = 'lightburn';
    let requests = 0;
    const server = http.createServer((req, res) => {
        requests++;
        assert.equal(req.method, 'GET');
        assert.equal(req.url, '/');
        assert.equal(req.headers.authorization, undefined);
        if (mode === 'redirect') {
            res.writeHead(302, { Location: '/elsewhere' });
        }
        res.end(mode === 'lightburn' ? '<title>LightBurn</title>' : 'Other service');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const port = server.address().port;
        const signal = new AbortController().signal;
        assert.equal((await probeHost('127.0.0.1', port, signal)).status, 'lightburn');
        mode = 'other';
        assert.equal((await probeHost('127.0.0.1', port, signal)).status, 'http-service');
        mode = 'redirect';
        assert.equal((await probeHost('127.0.0.1', port, signal)).httpStatus, 302);
        assert.equal(requests, 3);
        assert.deepEqual(await scanNetwork(['127.0.0.1'], port, AbortSignal.abort()), []);
        assert.equal(requests, 3);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('in-flight scans can be cancelled', async () => {
    const server = http.createServer(() => {});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const controller = new AbortController();
        const pending = probeHost('127.0.0.1', server.address().port, controller.signal);
        controller.abort();
        assert.equal(await pending, null);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
