# Arcane mail module

`arcane/modules/Mail.js` publishes the `window.mail` singleton. It validates recipients and subjects, creates deterministic notification reports, stores non-error reports when browser storage is available, and sends through the shared Arcane gateway with app and idempotency headers.

The default configuration comes from the application and page location:

- `<meta name="arcane-app-id" content="my-app">` supplies the app identity;
- HTTP loopback pages use port 8025 on their exact loopback hostname; and
- hosted HTTPS pages use same-origin `/v1/mail`.

Production browser code must not contain an SMTP password or gateway app key. The authenticated reverse proxy owns the production key and overwrites the identity headers before forwarding. Runtime configuration is optional and is intended for a reviewed endpoint/timeout override:

```js
globalThis.arcane={
    ...(globalThis.arcane||{}),
    config:{
        ...(globalThis.arcane?.config||{}),
        mail:{
            appName:'my-app',
            endpoint:'/v1/mail',
            requestTimeout:300_000,
        },
    },
}

await import('./arcane/modules/Mail.js')
```

Calling `mail.send(...)` without a valid app identity and HTTPS-or-loopback endpoint fails before a network request. See [`docs/mail-gateway.md`](../../docs/mail-gateway.md) for local SMTP setup and the authenticated hosted topology.

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

    if(!result.sent){
        console.warn('Delivery was not fully confirmed.',result.status)
    }
}catch(error){
    console.warn('Mail could not be sent.',error.message)
}
```

Supported message types are `error`, `report`, and `crisis_detected`. Reports and crisis notifications require at least one recipient. Error mail may use an empty recipient list when the gateway owns its fixed error recipients.

The runnable page in this directory uses the synthetic PreCrisis identity and automatic endpoint selection. Delivery still requires the local gateway or authenticated hosted route; it never embeds a credential.
