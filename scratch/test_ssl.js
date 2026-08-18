const https = require('https');

https.get('https://qldt.eaut.edu.vn/congthongtin/login.aspx', (res) => {
  console.log('Status Code:', res.statusCode);
  console.log('Headers:', res.headers);
}).on('error', (e) => {
  console.error('Error occurred:', e);
});
