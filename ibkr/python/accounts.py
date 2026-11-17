"""Checks the gateway session and prints the accounts it can trade.

Copy one into IBKR_ACCOUNT_ID. Which accounts appear depends on the username
you logged in to the gateway with: a paper username sees its paper account, a
live username its live ones.
"""

from __future__ import annotations

import os
import sys

from dotenv import load_dotenv

from ibkr import IbkrGateway, describe_error, is_paper_account, resolve_gateway_url


def main() -> None:
    load_dotenv()
    gateway_url = resolve_gateway_url(os.environ.get("IBKR_GATEWAY_URL"))
    gateway = IbkrGateway(gateway_url)

    print(f"Checking the gateway at {gateway_url}...\n")
    status = gateway.auth_status()
    if not status.authenticated:
        print("The gateway is running but not logged in.")
        print(f"Open {gateway_url} in a browser, log in, and run this again.")
        sys.exit(1)
    if status.competing:
        print("Warning: another session is logged in with this username. Log it out")
        print("(TWS, the mobile app, another gateway) or orders will fail.\n")

    # /iserver/accounts opens the brokerage session the order endpoints need;
    # /portfolio/accounts adds the descriptions.
    tradable = set(gateway.brokerage_accounts())
    accounts = gateway.portfolio_accounts()

    if not accounts:
        print("No accounts found for this session.")
        return

    for account in accounts:
        paper = is_paper_account(account.id)
        print(f"IBKR_ACCOUNT_ID={account.id}")
        print(
            f"  kind:      {'paper' if paper else 'LIVE (needs IBKR_ALLOW_LIVE=true)'}"
        )
        print(f"  title:     {account.title or 'unknown'}")
        print(f"  type:      {account.type or 'unknown'}")
        print(f"  currency:  {account.currency or 'unknown'}")
        print(f"  tradable:  {'yes' if account.id in tradable else 'no'}")
        print()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - print a hint instead of a traceback
        print(describe_error(error), file=sys.stderr)
        print(
            'Is the Client Portal Gateway running? See "Run the gateway" in the README.',
            file=sys.stderr,
        )
        sys.exit(1)
