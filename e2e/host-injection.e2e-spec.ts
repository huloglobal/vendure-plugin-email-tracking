// Must stay the first import: it points the licence SDK away from the live server.
import { E2E_PORT } from './local-licence-env';
import { Injectable } from '@nestjs/common';
import { mergeConfig, PluginCommonModule, TransactionalConnection, VendurePlugin } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import * as nodemailer from 'nodemailer';
import * as path from 'path';
import { initialData } from '../../../e2e-shared/initial-data';
// The plugin first, as the package index loads it (plugin.ts and the controller import each other).
import { EmailTrackingPlugin } from '../src/plugin';
import { EmailEvent } from '../src/email-event.entity';
import { EmailLog } from '../src/email-log.entity';
import { EmailTrackingController } from '../src/email-tracking.controller';
import { EmailTrackingService } from '../src/email-tracking.service';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));

const PORT = E2E_PORT + 1;

/** Host code that sends tracked mail: a service injecting EmailTrackingService. */
@Injectable()
class ReProvidedProbe {
    constructor(readonly tracking: EmailTrackingService) {}
}

@Injectable()
class ImportedProbe {
    constructor(readonly tracking: EmailTrackingService) {}
}

/** The 0.15.x way (ELITE's EES plugin does this): EmailTrackingService listed in the host plugin's own providers. */
@VendurePlugin({ imports: [PluginCommonModule], providers: [EmailTrackingService, ReProvidedProbe] })
class ReProvidingHostPlugin {}

/** Importing EmailTrackingPlugin, which exports its services. */
@VendurePlugin({ imports: [PluginCommonModule, EmailTrackingPlugin], providers: [ImportedProbe] })
class ImportingHostPlugin {}

describe('host plugins that inject EmailTrackingService (upgrade from 0.15.x)', () => {
    const config = mergeConfig(testConfig, {
        apiOptions: { port: PORT },
        plugins: [
            EmailTrackingPlugin.init({ publicBaseUrl: `http://localhost:${PORT}`, signingSecret: 'e2e-host-signing-secret' }),
            ReProvidingHostPlugin,
            ImportingHostPlugin,
        ],
    });
    const { server } = createTestEnvironment(config);

    beforeAll(async () => {
        // Before 0.16.0's fix this failed: "Nest can't resolve dependencies of the EmailTrackingService
        // (TransactionalConnection, ProcessContext, ?) … EmailEventService at index [2] … in the ReProvidingHostPlugin module".
        await server.init({ initialData, productsCsvPath: '', customerCount: 0 } as any);
    }, 60_000);

    afterAll(async () => {
        await server.destroy();
    });

    it('both hosts boot; a send through either instance is logged, with its send event on the timeline', async () => {
        const app = (server as any).app;
        const own: EmailTrackingService = (app.get(EmailTrackingController) as any).tracking;
        const reProvided: EmailTrackingService = app.get(ReProvidedProbe).tracking;
        const imported: EmailTrackingService = app.get(ImportedProbe).tracking;
        expect(imported).toBe(own); // importing the plugin injects its own instance
        expect(reProvided).toBeInstanceOf(EmailTrackingService);
        expect(reProvided).not.toBe(own); // re-providing makes a second instance, as it did in 0.15.x
        const conn: TransactionalConnection = app.get(TransactionalConnection);
        for (const [n, tracking] of [[1, reProvided], [2, imported]] as const) {
            const row = await tracking.sendTracked(nodemailer.createTransport({ streamTransport: true, buffer: true }),
                { from: 'shop@example.com', to: `host${n}@example.com`, subject: `Host send ${n}`, html: '<p>Hello</p>' },
                { type: 'host-send', channelId: 1 });
            expect(row.status).toBe('sent');
            expect(await conn.rawConnection.getRepository(EmailLog).count({ where: { id: row.id } })).toBe(1);
            const events = await conn.rawConnection.getRepository(EmailEvent).find({ where: { emailLogId: Number(row.id) } });
            expect(events.map(e => `${e.source}:${e.type}`)).toEqual(['smtp:sent']);
        }
    });
});
