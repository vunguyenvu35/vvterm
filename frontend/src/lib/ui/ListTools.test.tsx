import {render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {useState} from 'react'
import {byName, FilterChip, ListToolbar, usePref, VIEWS, type SortOption} from './ListTools'

const OPTIONS: SortOption<'a' | 'b'>[] = [{value: 'a', label: 'Alpha'}, {value: 'b', label: 'Beta'}]

function Demo() {
  const [q, setQ] = useState('')
  const [sort, setSort] = usePref('test.sort', ['a', 'b'] as const, 'a')
  const [view, setView] = usePref('test.view', VIEWS, 'grid')
  const [on, setOn] = useState(false)
  return (
    <>
      <ListToolbar what="things" query={q} onQuery={setQ} sort={sort} sortOptions={OPTIONS} onSort={setSort} view={view} onView={setView}>
        <FilterChip label="Only mine" on={on} onToggle={() => setOn(!on)} />
      </ListToolbar>
      <output data-testid="state">{`${q}|${sort}|${view}|${on}`}</output>
    </>
  )
}
const state = () => screen.getByTestId('state').textContent
beforeEach(() => localStorage.clear())

describe('ListToolbar', () => {
  it('has a search box, filters, a sort menu and a grid / list switch', async () => {
    render(<Demo />)
    await userEvent.type(screen.getByLabelText('Search things'), 'ab')
    expect(state()).toBe('ab|a|grid|false')
    await userEvent.click(screen.getByRole('button', {name: 'Only mine'}))
    expect(state()).toBe('ab|a|grid|true')
    expect(screen.getByRole('button', {name: 'Only mine'})).toHaveAttribute('aria-pressed', 'true')
  })

  it('the sort menu shows the current order with a check and changes it', async () => {
    render(<Demo />)
    await userEvent.click(screen.getByRole('button', {name: 'Sort'}))
    const menu = screen.getByRole('menu', {name: 'Sort'})
    expect(within(menu).getByRole('menuitemradio', {name: /Alpha/})).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(within(menu).getByRole('menuitemradio', {name: /Beta/}))
    expect(state()).toBe('|b|grid|false')
    expect(screen.queryByRole('menu', {name: 'Sort'})).toBeNull() // choosing closes it
    await userEvent.click(screen.getByRole('button', {name: 'Sort'}))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu', {name: 'Sort'})).toBeNull()
  })

  it('remembers the sort and the view, and falls back to the defaults for a value it does not know', async () => {
    const {unmount} = render(<Demo />)
    await userEvent.click(screen.getByRole('button', {name: 'Sort'}))
    await userEvent.click(screen.getByRole('menuitemradio', {name: /Beta/}))
    await userEvent.click(screen.getByRole('button', {name: 'View'}))
    await userEvent.click(screen.getByRole('menuitemradio', {name: /List/}))
    expect(state()).toBe('|b|list|false')
    unmount()
    const second = render(<Demo />)
    expect(state()).toBe('|b|list|false')
    localStorage.setItem('test.sort', 'bogus')
    second.unmount()
    render(<Demo />)
    expect(state()).toBe('|a|list|false')
  })
})

describe('byName', () => {
  it('ignores case and accents and counts numbers as numbers', () => {
    expect(['web-10', 'Web-2', 'écho', 'web-1', 'Zed'].sort(byName)).toEqual(['écho', 'web-1', 'Web-2', 'web-10', 'Zed'])
  })
})
