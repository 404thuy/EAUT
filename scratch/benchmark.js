const http = require('http');
const { performance } = require('perf_hooks');

function testEndpoint(url) {
  return new Promise((resolve) => {
    const start = performance.now();
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const duration = performance.now() - start;
        resolve({ statusCode: res.statusCode, duration: Math.round(duration), size: data.length });
      });
    }).on('error', (err) => {
      resolve({ error: err.message, duration: Math.round(performance.now() - start) });
    });
  });
}

async function runBenchmark() {
  console.log("=== BASELINE BENCHMARK ===");
  const health = await testEndpoint('http://localhost:5000/health');
  console.log("Health Check:", health);

  const home = await testEndpoint('http://localhost:5000/');
  console.log("Homepage HTML:", home);

  const favicon = await testEndpoint('http://localhost:5000/favicon.png');
  console.log("Favicon (557KB PNG):", favicon);

  const css = await testEndpoint('http://localhost:5000/styles.css');
  console.log("Styles CSS:", css);
}

runBenchmark();
