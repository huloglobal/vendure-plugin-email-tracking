import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { SharedModule } from '@vendure/admin-ui/core';
import { FormsModule } from '@angular/forms';
import { HttpClientModule } from '@angular/common/http';
import { EmailLogComponent } from './components/email-log.component';
import { OrderActivityPageComponent } from './components/order-activity-page.component';
import { EmailTrackingToolsComponent } from './components/email-tracking-tools.component';

@NgModule({
    imports: [
        SharedModule, FormsModule, HttpClientModule, EmailTrackingToolsComponent,
        RouterModule.forChild([
            { path: '', pathMatch: 'full', component: EmailLogComponent, data: { breadcrumb: 'Email Log' } },
            {
                path: 'orders/:orderId',
                component: OrderActivityPageComponent,
                data: { breadcrumb: [{ label: 'Email Log', link: ['/extensions', 'email-log'] }, { label: 'Order activity', link: [] }] },
            },
        ]),
    ],
    declarations: [EmailLogComponent, OrderActivityPageComponent],
})
export class EmailLogModule {}
