import http from 'node:http';
import {readFile} from 'node:fs/promises';
const files = {'/':'index.html','/index.html':'index.html','/app.js':'app.js','/finance.js':'finance.js','/styles.css':'styles.css','/favicon.svg':'favicon.svg'};
const types = {html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml'};
http.createServer(async(req,res)=>{try{const file=files[new URL(req.url,'http://localhost').pathname];if(!file){res.writeHead(404);return res.end('No encontrado');} const body=await readFile(new URL('./dist/'+file,import.meta.url));res.writeHead(200,{'Content-Type':types[file.split('.').pop()],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(body);}catch{res.writeHead(500);res.end('No se pudo abrir la aplicación');}}).listen(5173,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:5173'));
