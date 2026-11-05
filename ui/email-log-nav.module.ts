import { NgModule } from '@angular/core';
import { SharedModule, addNavMenuItem, registerCustomDetailComponent, registerDashboardWidget, registerPageTab } from '@vendure/admin-ui/core';
import { OrderEmailActivityPanelComponent } from './components/order-email-activity-panel.component';
import { CustomerEmailsTabComponent } from './components/customer-emails-tab.component';

/**
 * Registers the "Email Log" entry in the admin nav (plugged into the
 * existing "Customers" section so account-handling staff find it where
 * they expect), the "Email Tracking" dashboard widget
 * (Dashboard → Add widget → Email Tracking), the "Email activity" panel on
 * the order detail page and the "Emails" tab on the customer detail page.
 */
@NgModule({
    imports: [SharedModule],
    providers: [
        addNavMenuItem(
            {
                id: 'hulo-email-log',
                label: 'Email Log',
                routerLink: ['/extensions/email-log'],
                icon: 'envelope',
                requiresPermission: 'ReadCustomer',
            },
            'customers',
        ),
        registerDashboardWidget('hulo-vendure-plugin-email-tracking', {
            title: 'Email Tracking',
            supportedWidths: [4, 6, 8],
            requiresPermissions: ['ReadCustomer'],
            loadComponent: () => import('./components/email-tracking-widget.component').then(m => m.EmailTrackingWidgetComponent),
        }),
        registerCustomDetailComponent({
            locationId: 'order-detail',
            component: OrderEmailActivityPanelComponent,
        }),
        registerPageTab({
            location: 'customer-detail',
            tab: 'Emails',
            tabIcon: 'envelope',
            route: 'emails',
            priority: 10,
            component: CustomerEmailsTabComponent,
        }),
    ],
})
export class EmailLogNavModule {}
