import SystemToolRegistry,{quoteArgument} from '../../../arcane/modules/SystemToolRegistry.js';

function requireApp(args,usage){const id=String(args[0]||'').trim();if(!/^[a-z][a-z0-9-]*$/.test(id))throw new TypeError(`Usage: ${usage}`);return id;}

export default function createArcaneSystemTools(){
    return new SystemToolRegistry([
        {id:'apps',label:'List Arcane applications',description:'List Arcane application distribution packages and versions.',usage:'tool apps',command:'npm run apps:list'},
        {id:'app-inspect',label:'Inspect application',description:'Inspect an Arcane application package allowlist, shared payload, and size.',usage:'tool app-inspect <app>',command:args=>`npm run app:inspect -- ${quoteArgument(requireApp(args,'tool app-inspect <app>'))}`},
        {id:'app-package',label:'Package application',description:'Build the current Arcane application version into dist/<app>.',usage:'tool app-package <app>',command:args=>`npm run app:package -- ${quoteArgument(requireApp(args,'tool app-package <app>'))}`},
        {id:'app-check',label:'Check application',description:'Verify an Arcane application distribution package exactly.',usage:'tool app-check <app>',command:args=>`npm run app:check -- ${quoteArgument(requireApp(args,'tool app-check <app>'))}`},
        {id:'app-release',label:'Release application',description:'Build, verify, and patch-bump an Arcane application release.',usage:'tool app-release <app>',command:args=>`npm run app:release -- ${quoteArgument(requireApp(args,'tool app-release <app>'))}`},
        {id:'native-apps',label:'List native targets',description:'List Arcane machine-bundle targets for native hosting.',usage:'tool native-apps',command:'npm --prefix machine_bundles/arcane-os-machine-bundle-v0.8.4 run build:app -- --list'},
        {id:'native-app-build',label:'Build native target',description:'Build an isolated portable or Microsoft NT native host target for an Arcane application.',usage:'tool native-app-build <app> [portable|nt]',command:args=>{const id=requireApp(args,'tool native-app-build <app> [portable|nt]');const requested=String(args[1]||'portable').toLowerCase();const platform={portable:'portable',nt:'windows','microsoft-nt':'windows',windows:'windows'}[requested];if(!platform)throw new TypeError('Platform must be portable or nt (Microsoft NT).');return `npm --prefix machine_bundles/arcane-os-machine-bundle-v0.8.4 run build:app -- --app=${quoteArgument(id)} --platform=${platform}`;}},
        {id:'test',label:'Run shared tests',description:'Run the fast shared Arcane OS test suite.',usage:'tool test',command:'npm test'},
        {id:'check',label:'Run full checks',description:'Run shared, app, package, and machine verification.',usage:'tool check',command:'npm run check'}
    ]);
}
