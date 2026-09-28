import importlib.util
import pathlib
import sqlite3
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('migration', ROOT / 'scripts/migrate-local.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)

class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        migration.migrate(self.db)
        for user in ['a','b','c']:
            self.db.execute('INSERT INTO users(id,auth_issuer,auth_subject) VALUES (?,?,?)',(user,'test',user))
        self.db.execute("INSERT INTO households(id,name) VALUES ('home','Juntos'),('other','Otro')")
        self.db.execute("INSERT INTO household_members(household_id,user_id,slot,display_name) VALUES ('home','a','blue','Él'),('home','b','pink','Ella'),('other','c','blue','Otro')")

    def tearDown(self):
        self.db.close()

    def add(self, id='t', amount=101, kind='expense', scope='shared', owner=None, creator='a', date='2026-09-28', home='home'):
        self.db.execute('INSERT INTO transactions(id,household_id,kind,scope,amount_cents,description,occurred_on,category,owner_user_id,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)', (id,home,kind,scope,amount,'Ejemplo',date,'Hogar',owner,creator))

    def test_split_and_personal(self):
        self.add()
        self.assertEqual(self.db.execute('SELECT slot,signed_amount_cents FROM transaction_allocations ORDER BY slot').fetchall(), [('blue',-50),('pink',-51)])
        self.add(id='p',amount=500,scope='personal',owner='b')
        self.assertEqual(self.db.execute("SELECT user_id,signed_amount_cents FROM transaction_allocations WHERE transaction_id='p'").fetchall(), [('b',-500)])

    def test_monthly_totals_and_edit(self):
        self.add(id='income',amount=800000,kind='income',scope='personal',owner='a')
        self.add(amount=20000)
        self.add(id='next',date='2026-10-01')
        query="SELECT sum(signed_amount_cents) FROM transaction_allocations WHERE household_id='home' AND occurred_on>='2026-09-01' AND occurred_on<'2026-10-01'"
        self.assertEqual(self.db.execute(query).fetchone()[0],780000)
        self.db.execute("UPDATE transactions SET amount_cents=40000 WHERE id='t'")
        self.assertEqual(self.db.execute(query).fetchone()[0],760000)
        self.db.execute("DELETE FROM transactions WHERE id='t'")
        self.assertEqual(self.db.execute(query).fetchone()[0],800000)

    def test_invalid_amounts_dates_and_income_split(self):
        for amount in [0,-1,1.5,100000000001]:
            with self.assertRaises(sqlite3.IntegrityError): self.add(amount=amount)
        for date in ['2026-02-30','2026-13-01','not-a-date']:
            with self.assertRaises(sqlite3.IntegrityError): self.add(date=date)
        with self.assertRaises(sqlite3.IntegrityError): self.add(kind='income')

    def test_cross_household_references(self):
        with self.assertRaises(sqlite3.IntegrityError): self.add(creator='c')
        with self.assertRaises(sqlite3.IntegrityError): self.add(scope='personal',owner='c')

    def test_two_members_and_historical_identity(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO household_members VALUES ('home','c','blue','Tercero',CURRENT_TIMESTAMP)")
        with self.assertRaises(sqlite3.IntegrityError): self.add(home='other',creator='c')
        self.add()
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("DELETE FROM household_members WHERE user_id='b'")
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("UPDATE household_members SET slot='pink' WHERE user_id='a'")

    def test_goal_unique_and_validated(self):
        sql='INSERT INTO monthly_goals(household_id,month,name,amount_cents,created_by) VALUES (?,?,?,?,?)'
        self.db.execute(sql,('home','2026-09','Viaje',400000,'a'))
        for values in [('home','2026-09','Otra',1,'b'),('home','2026-13','Otra',1,'a'),('home','2026-10','Otra',1,'c'),('home','2026-10','Otra',0,'a')]:
            with self.assertRaises(sqlite3.IntegrityError): self.db.execute(sql,values)

    def test_migration_rerun_preserves_records(self):
        self.add()
        migration.migrate(self.db)
        self.assertEqual(self.db.execute('SELECT count(*) FROM transactions').fetchone()[0],1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM schema_migrations').fetchone()[0],1)
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(),[])

if __name__ == '__main__':
    unittest.main()
