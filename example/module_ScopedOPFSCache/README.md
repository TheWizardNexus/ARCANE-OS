# Scoped OPFS cache example

`ScopedOPFSCache` gives a consumer exact-key JSON caching inside one named Origin Private File System directory. It intentionally has no list, clear-all, export, or restore method, so cache maintenance cannot cross an application's namespace.

```js
import ScopedOPFSCache from '../../arcane/modules/ScopedOPFSCache.js';

const cache=new ScopedOPFSCache({
    applicationId:'my-app',
    namespace:'my-app-cache-v1',
    maxEntryBytes:1024*1024
});

await cache.set('welcome',{message:'Stored only in apps/my-app/my-app-cache-v1'});
const value=await cache.get('welcome');
await cache.delete('welcome');
```

The cache requires HTTPS or localhost in a browser with OPFS support. It stores data beneath `apps/<application-id>/<namespace>` and does not request persistence automatically; the parent experience owns that policy and disclosure. Browser folders prevent accidental cross-app operations, while a separate native profile or origin remains the security boundary against hostile same-origin code.
