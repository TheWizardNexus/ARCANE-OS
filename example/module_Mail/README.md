# Arcane mail module

`arcane/modules/Mail.js` publishes the `window.mail` singleton. It validates recipients and subjects, creates notification reports, stores non-error reports when browser storage is available, and sends through the configured mail gateway with app and idempotency headers.

Mail transport has no embedded endpoint or credential. The parent application must provide runtime configuration before importing the module:

```js
globalThis.arcane={
    ...(globalThis.arcane||{}),
    config:{
        ...(globalThis.arcane?.config||{}),
        mail:{
            appName:'my-app',
            appKey:runtimeSecret,
            endpoint:'https://mail.example.test/v1/mail',
            requestTimeout:300_000,
        },
    },
}

await import('./arcane/modules/Mail.js')
```

Inject `runtimeSecret` outside tracked source. Calling `mail.send(...)` without both `appKey` and `endpoint` fails before a network request is made.

## Sending a report

```js
try{
    const result=await mail.send(
        ['recipient@example.com'],
        'Daily Check-In Summary',
        { notes:'Synthetic example content.' },
        '',
        'report'
    )

    console.log(result.status,result.reportKey)
}catch(error){
    console.warn('Mail could not be sent.',error.message)
}
```

Supported message types are `error`, `report`, and `crisis_detected`. Reports and crisis notifications require at least one recipient. Error mail may use an empty recipient list when the gateway owns its fixed error recipients.

The runnable page in this directory is a UI demonstration only; delivery requires the parent page to inject a valid runtime configuration.
